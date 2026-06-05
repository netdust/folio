import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { resolve } from 'node:path';
import * as schema from '../db/schema.ts';
import { messages } from '../db/schema.ts';
import {
  appendMessage,
  createConversation,
  getThread,
  serializeThreadMarkdown,
} from './conversations.ts';

function makeDb() {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: resolve(import.meta.dir, '../db/migrations') });
  return db;
}

describe('conversation service', () => {
  test('appendMessage assigns monotonic seq and emits NO events (M10)', async () => {
    const db = makeDb();
    const c = await createConversation(db, {
      createdBy: 'u1',
      operatorAgentId: 'op1',
      title: 'Untitled',
    });
    await appendMessage(db, { conversationId: c.id, role: 'user', kind: 'text', body: 'set up a project' });
    await appendMessage(db, { conversationId: c.id, role: 'operator', kind: 'text', body: 'done' });
    const thread = await getThread(db, c.id);
    expect(thread.map((m) => m.seq)).toEqual([1, 2]);
    // M10 — conversation persistence is walled off from the event stream.
    const evRows = await db.query.events.findMany();
    expect(evRows.length).toBe(0);
  });

  test('appendMessage continues the seq across a second batch', async () => {
    const db = makeDb();
    const c = await createConversation(db, {
      createdBy: 'u1',
      operatorAgentId: 'op1',
      title: 'Untitled',
    });
    await appendMessage(db, { conversationId: c.id, role: 'user', kind: 'text', body: 'a' });
    await appendMessage(db, { conversationId: c.id, role: 'operator', kind: 'text', body: 'b' });
    await appendMessage(db, { conversationId: c.id, role: 'user', kind: 'text', body: 'c' });
    const thread = await getThread(db, c.id);
    expect(thread.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  test('serializeThreadMarkdown renders turns + tool steps + components', async () => {
    const db = makeDb();
    const c = await createConversation(db, {
      createdBy: 'u1',
      operatorAgentId: 'op1',
      title: 'Untitled',
    });
    await appendMessage(db, { conversationId: c.id, role: 'user', kind: 'text', body: 'hi' });
    await appendMessage(db, {
      conversationId: c.id,
      role: 'operator',
      kind: 'tool_step',
      payload: { tool: 'create_document', summary: 'Created Onboard Acme', status: 'ok' },
    });
    await appendMessage(db, {
      conversationId: c.id,
      role: 'operator',
      kind: 'component',
      payload: { type: 'choice_card', prompt: 'Which template?', chosen: 'Leads' },
    });
    const md = await serializeThreadMarkdown(db, c.id);
    expect(md).toContain('hi');
    expect(md).toContain('Created Onboard Acme');
    expect(md).toContain('Which template?');
    expect(md).toContain('Leads');
  });

  // Cluster-1 /code-review fix #1: the unique (conversation_id, seq) index is the
  // structural backstop for the MAX(seq)+1 allocator. If the single-active-turn CAS
  // (M14, T6) is ever bypassed, a duplicate seq must FAIL LOUD, not silently corrupt
  // thread order. This test bypasses the allocator (direct insert of a colliding seq)
  // and asserts the DB rejects it. Bites: against the old plain index it would PASS.
  test('a duplicate (conversation_id, seq) is rejected by the unique index (fix #1)', async () => {
    const db = makeDb();
    const c = await createConversation(db, {
      createdBy: 'u1',
      operatorAgentId: 'op1',
      title: 'Untitled',
    });
    const first = await appendMessage(db, {
      conversationId: c.id,
      role: 'user',
      kind: 'text',
      body: 'a',
    });
    // Direct insert colliding on the same (conversation_id, seq) — simulates a
    // bypassed CAS / concurrent appender that read the same MAX(seq).
    expect(() =>
      db
        .insert(messages)
        .values({
          id: crypto.randomUUID(),
          conversationId: c.id,
          seq: first.seq, // collision
          role: 'operator',
          kind: 'text',
          body: 'b',
        })
        .run(),
    ).toThrow();
  });

  // Cluster-1 /code-review fix #3: serializeThreadMarkdown must survive a malformed
  // payload row — one bad row degrades to an empty line, never aborts the whole export.
  // Bites: against the old unguarded JSON.parse this would throw SyntaxError.
  test('serializeThreadMarkdown tolerates a malformed payload row (fix #3)', async () => {
    const db = makeDb();
    const c = await createConversation(db, {
      createdBy: 'u1',
      operatorAgentId: 'op1',
      title: 'Untitled',
    });
    await appendMessage(db, { conversationId: c.id, role: 'user', kind: 'text', body: 'before' });
    // Direct insert of a non-JSON payload on a tool_step row (a future writer / DB edit).
    db.insert(messages)
      .values({
        id: crypto.randomUUID(),
        conversationId: c.id,
        seq: 2,
        role: 'operator',
        kind: 'tool_step',
        body: '',
        payload: 'this is not json{', // malformed
      })
      .run();
    await appendMessage(db, { conversationId: c.id, role: 'operator', kind: 'text', body: 'after' });
    // Must not throw, and the surrounding good rows still render.
    const md = await serializeThreadMarkdown(db, c.id);
    expect(md).toContain('before');
    expect(md).toContain('after');
  });
});
