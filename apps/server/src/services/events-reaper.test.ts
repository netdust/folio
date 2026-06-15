import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import * as schema from '../db/schema.ts';
import { events, reactorCursors, workspaces } from '../db/schema.ts';
import { env } from '../env.ts';
import { reapStaleEvents } from './events-reaper.ts';

function makeDb() {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: resolve(import.meta.dir, '../db/migrations') });
  return db;
}

const RETENTION = env.FOLIO_EVENTS_RETENTION_MS;
const WS = 'ws-evt-reaper';

// A fixed wall clock so age math is deterministic — never Date.now().
const NOW = 1_900_000_000_000;
const DAYS = 24 * 60 * 60 * 1000;

async function seedWorkspace(db: ReturnType<typeof makeDb>): Promise<void> {
  await db.insert(workspaces).values({ id: WS, slug: 'evt-reaper', name: 'Evt Reaper' });
}

type SeedEvent = { id: string; seq: number; ageDays: number };

async function seedEvents(db: ReturnType<typeof makeDb>, rows: SeedEvent[]): Promise<void> {
  for (const r of rows) {
    await db.insert(events).values({
      id: r.id,
      workspaceId: WS,
      kind: 'document.created',
      payload: {},
      seq: r.seq,
      createdAt: new Date(NOW - r.ageDays * DAYS),
    });
  }
}

async function seedCursor(db: ReturnType<typeof makeDb>, reactorId: string, lastSeq: number) {
  await db.insert(reactorCursors).values({ reactorId, lastSeq });
}

describe('reapStaleEvents — cursor-floored retention (H7)', () => {
  test('does NOT delete an old event ABOVE the min reactor cursor', async () => {
    const db = makeDb();
    await seedWorkspace(db);
    await seedEvents(db, [{ id: 'e10', seq: 10, ageDays: 100 }]);
    await seedCursor(db, 'r1', 5);

    const reaped = await reapStaleEvents(db, NOW);

    expect(reaped).toBe(0);
    const rows = await db.select().from(events).where(eq(events.id, 'e10'));
    expect(rows).toHaveLength(1);
  });

  test('DELETES an old event strictly below the min reactor cursor', async () => {
    const db = makeDb();
    await seedWorkspace(db);
    await seedEvents(db, [{ id: 'e3', seq: 3, ageDays: 100 }]);
    await seedCursor(db, 'r1', 5);

    const reaped = await reapStaleEvents(db, NOW);

    expect(reaped).toBe(1);
    const rows = await db.select().from(events).where(eq(events.id, 'e3'));
    expect(rows).toHaveLength(0);
  });

  test('deletes NOTHING when there are no reactor cursors (nothing provably dead)', async () => {
    const db = makeDb();
    await seedWorkspace(db);
    await seedEvents(db, [{ id: 'e1', seq: 1, ageDays: 100 }]);
    // no cursor seeded

    const reaped = await reapStaleEvents(db, NOW);

    expect(reaped).toBe(0);
    const rows = await db.select().from(events).where(eq(events.id, 'e1'));
    expect(rows).toHaveLength(1);
  });

  test('does NOT delete a recent event even below the cursor', async () => {
    const db = makeDb();
    await seedWorkspace(db);
    await seedEvents(db, [{ id: 'e2', seq: 2, ageDays: 1 }]);
    await seedCursor(db, 'r1', 5);

    const reaped = await reapStaleEvents(db, NOW);

    expect(reaped).toBe(0);
    const rows = await db.select().from(events).where(eq(events.id, 'e2'));
    expect(rows).toHaveLength(1);
  });

  test('floors on the MINIMUM cursor across reactors (a lagging reactor protects its queue)', async () => {
    const db = makeDb();
    await seedWorkspace(db);
    // seq=4 is below r-fast(8) but at/above r-slow(2)? 4 > 2 so it must survive.
    await seedEvents(db, [{ id: 'e4', seq: 4, ageDays: 100 }]);
    await seedCursor(db, 'r-fast', 8);
    await seedCursor(db, 'r-slow', 2);

    const reaped = await reapStaleEvents(db, NOW);

    expect(reaped).toBe(0); // min cursor is 2; seq 4 is NOT < 2
    const rows = await db.select().from(events).where(eq(events.id, 'e4'));
    expect(rows).toHaveLength(1);
  });

  // SEAM (invariant 8): the reaper wires into the event plane. Prove it does not
  // break the SSE-replay / dispatcher-poll shape — an event ABOVE the min cursor
  // must still be queryable by seq ASC (the exact shape replay + the poller use).
  test('SEAM: preserves the replay horizon — survivors stay queryable by seq ASC', async () => {
    const db = makeDb();
    await seedWorkspace(db);
    await seedEvents(db, [
      { id: 'old-dead', seq: 3, ageDays: 100 }, // below cursor + old → reaped
      { id: 'old-live', seq: 9, ageDays: 100 }, // above cursor → survives
      { id: 'fresh', seq: 12, ageDays: 0 }, // recent → survives
    ]);
    await seedCursor(db, 'r1', 5);

    const reaped = await reapStaleEvents(db, NOW);
    expect(reaped).toBe(1);

    // The SSE-replay / dispatcher read: rows ASC by seq, unbroken above the floor.
    const surviving = await db.select().from(events).orderBy(asc(events.seq));
    expect(surviving.map((r) => r.seq)).toEqual([9, 12]);
    expect(surviving.map((r) => r.id)).toEqual(['old-live', 'fresh']);
  });

  // Pins the RETENTION cutoff itself (not just "age matters"). Both events are
  // below the cursor, so only the retention window decides: one just past the
  // window is reaped, one just inside survives. Catches a mis-wired knob (e.g.
  // reading the wrong env var) that the cursor-floor tests alone would not.
  test('reaps just PAST the retention window, spares just INSIDE it', async () => {
    const db = makeDb();
    await seedWorkspace(db);
    const retentionDays = RETENTION / DAYS;
    await seedEvents(db, [
      { id: 'just-past', seq: 1, ageDays: retentionDays + 1 }, // older than retention → reaped
      { id: 'just-inside', seq: 2, ageDays: retentionDays - 1 }, // within retention → survives
    ]);
    await seedCursor(db, 'r1', 10); // both seqs are below the cursor — only age decides

    const reaped = await reapStaleEvents(db, NOW);

    expect(reaped).toBe(1);
    const surviving = await db.select().from(events).orderBy(asc(events.seq));
    expect(surviving.map((r) => r.id)).toEqual(['just-inside']);
  });

  test('reaps MORE than one chunk (multi-batch loop deletes the full backlog)', async () => {
    // The DELETE is chunked (CHUNK=1000) to bound the writer-lock hold on a large
    // first-run backlog. Seed >1 chunk of reapable rows + a few survivors above the
    // cursor, and assert the loop reaps the entire eligible set across batches —
    // a single-batch reaper would leave the overflow behind.
    const db = makeDb();
    await seedWorkspace(db);
    const N = 1300; // > CHUNK
    const reapable = Array.from({ length: N }, (_, i) => ({
      id: `dead-${i}`,
      seq: i + 1, // 1..1300, all below the cursor (5000)
      ageDays: 100,
    }));
    await seedEvents(db, [
      ...reapable,
      { id: 'live-above', seq: 9000, ageDays: 100 }, // above cursor → survives
    ]);
    await seedCursor(db, 'r1', 5000);

    const reaped = await reapStaleEvents(db, NOW);

    expect(reaped).toBe(N); // every eligible row, across multiple batches
    const surviving = await db.select().from(events);
    expect(surviving.map((r) => r.id)).toEqual(['live-above']);
  });
});
