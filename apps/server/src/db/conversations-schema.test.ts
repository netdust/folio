import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import * as schema from './schema.ts';
import { conversations, messages, pendingOps } from './schema.ts';

function makeDb() {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: resolve(import.meta.dir, 'migrations') });
  return db;
}

describe('conversation schema', () => {
  test('a conversation + ordered messages persist and read back by seq', async () => {
    const db = makeDb();
    const convId = crypto.randomUUID();
    await db.insert(conversations).values({
      id: convId,
      title: 'Untitled',
      createdBy: 'user-1',
      operatorAgentId: 'op-1',
      activeRunId: null,
    });
    await db.insert(messages).values([
      {
        id: crypto.randomUUID(),
        conversationId: convId,
        seq: 1,
        role: 'user',
        kind: 'text',
        body: 'hi',
        payload: null,
        runId: null,
      },
      {
        id: crypto.randomUUID(),
        conversationId: convId,
        seq: 2,
        role: 'operator',
        kind: 'tool_step',
        body: '',
        payload: JSON.stringify({ tool: 'create_document', summary: 'Created X', status: 'ok' }),
        runId: 'run-1',
      },
    ]);
    const rows = await db.query.messages.findMany({
      where: eq(messages.conversationId, convId),
      orderBy: (m, { asc }) => [asc(m.seq)],
    });
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(rows[1]?.kind).toBe('tool_step');
  });

  test('pending_ops row records op + params + caller for the confirm gate', async () => {
    const db = makeDb();
    const id = crypto.randomUUID();
    await db.insert(pendingOps).values({
      id,
      conversationId: 'c1',
      callerId: 'user-1',
      op: 'delete_workspace',
      params: JSON.stringify({ wslug: 'acme' }),
      target: 'acme',
      status: 'pending',
      expiresAt: new Date('2026-06-03T00:05:00Z'),
    });
    const row = await db.query.pendingOps.findFirst({ where: eq(pendingOps.id, id) });
    expect(row?.status).toBe('pending');
    expect(JSON.parse(row!.params).wslug).toBe('acme');
    // audit columns default to null (populated only on execute, T7)
    expect(row?.executedAt).toBeNull();
    expect(row?.executedBy).toBeNull();
  });
});
