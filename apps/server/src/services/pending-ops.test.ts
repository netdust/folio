import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema.ts';
import { type PendingOp, pendingOps } from '../db/schema.ts';
import { PENDING_OPS_RETENTION_MS, reapStalePendingOps } from './pending-ops.ts';

function makeDb() {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: resolve(import.meta.dir, '../db/migrations') });
  return db;
}

const RETENTION = PENDING_OPS_RETENTION_MS;

type SeedRow = {
  id: string;
  status: PendingOp['status'];
  createdAt: number;
  expiresAt: number;
};

async function seed(
  db: ReturnType<typeof makeDb>,
  rows: SeedRow[],
): Promise<void> {
  for (const r of rows) {
    await db.insert(pendingOps).values({
      id: r.id,
      conversationId: 'c1',
      callerId: 'u1',
      op: 'delete_document',
      params: '{}',
      target: 't1',
      status: r.status,
      createdAt: new Date(r.createdAt),
      expiresAt: new Date(r.expiresAt),
      executedAt: null,
      executedBy: null,
    });
  }
}

async function remainingIds(db: ReturnType<typeof makeDb>): Promise<string[]> {
  const rows = await db.select({ id: pendingOps.id }).from(pendingOps);
  return rows.map((r) => r.id).sort();
}

describe('reapStalePendingOps', () => {
  test('reaps only rows that can no longer be live (terminal-old + abandoned-pending)', async () => {
    const db = makeDb();
    const now = 1_700_000_000_000;
    const old = now - RETENTION - 60_000; // safely past the retention window
    const recent = now - 60_000; // well within the retention window

    await seed(db, [
      // REAP: terminal + old
      { id: 'executed-old', status: 'executed', createdAt: old, expiresAt: old + 1000 },
      { id: 'rejected-old', status: 'rejected', createdAt: old, expiresAt: old + 1000 },
      { id: 'expired-old', status: 'expired', createdAt: old, expiresAt: old + 1000 },
      // REAP: abandoned pending (expiresAt past the retention window)
      { id: 'pending-abandoned', status: 'pending', createdAt: old, expiresAt: old + 1000 },
      // KEEP: terminal but recent (audit window)
      { id: 'executed-recent', status: 'executed', createdAt: recent, expiresAt: recent + 1000 },
      // KEEP: pending within TTL (live confirm-card)
      { id: 'pending-live', status: 'pending', createdAt: recent, expiresAt: now + 60_000 },
      // KEEP: confirmed at ANY age (recorded params about to be replayed)
      { id: 'confirmed-old', status: 'confirmed', createdAt: old, expiresAt: old + 1000 },
    ]);

    const reaped = await reapStalePendingOps(db, now);

    expect(reaped).toBe(4);
    expect(await remainingIds(db)).toEqual(
      ['confirmed-old', 'executed-recent', 'pending-live'].sort(),
    );
  });

  test('NEVER reaps a confirmed row, no matter how old (invariant 12)', async () => {
    const db = makeDb();
    const now = 1_700_000_000_000;
    const ancient = now - RETENTION * 10;

    await seed(db, [
      { id: 'confirmed-ancient', status: 'confirmed', createdAt: ancient, expiresAt: ancient + 1000 },
    ]);

    const reaped = await reapStalePendingOps(db, now);

    expect(reaped).toBe(0);
    const survivor = await db
      .select()
      .from(pendingOps)
      .where(eq(pendingOps.id, 'confirmed-ancient'))
      .then((r) => r[0]);
    expect(survivor?.status).toBe('confirmed');
  });
});
