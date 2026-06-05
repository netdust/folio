import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { resolve } from 'node:path';
import * as schema from '../db/schema.ts';
import { appendMessage, createConversation, getThread } from '../services/conversations.ts';
import { buildConversationMessages, CONVERSATION_HISTORY_WINDOW } from './chat-thread-source.ts';
import { makeConversationSink } from './chat-thread-sink.ts';

function makeDb() {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  // lib/ is a sibling of db/ — migrations live at ../db/migrations.
  migrate(db, { migrationsFolder: resolve(import.meta.dir, '../db/migrations') });
  return db;
}

describe('chat adapter', () => {
  test('source replays user+operator turns and a chosen choice_card into runner messages', async () => {
    const db = makeDb();
    const c = await createConversation(db, {
      createdBy: 'u1',
      operatorAgentId: 'op1',
      title: 'Untitled',
    });
    await appendMessage(db, {
      conversationId: c.id,
      role: 'user',
      kind: 'text',
      body: 'set up a project',
    });
    await appendMessage(db, {
      conversationId: c.id,
      role: 'operator',
      kind: 'component',
      payload: {
        type: 'choice_card',
        prompt: 'Which template?',
        options: [{ id: 'leads', label: 'Leads' }],
        chosen: 'leads',
      },
    });
    const msgs = await buildConversationMessages(db, c.id);
    // a user turn is replayed as a provider `user` message
    expect(msgs.some((m) => m.role === 'user' && String(m.content).includes('set up a project'))).toBe(
      true,
    );
    // the chosen option appears so the operator sees the user's pick on resume
    expect(msgs.some((m) => String(m.content).includes('leads'))).toBe(true);
  });

  test('source windows to the last N rows (bounded BYOK replay, Cluster-6 perf fix)', async () => {
    const db = makeDb();
    const c = await createConversation(db, {
      createdBy: 'u1',
      operatorAgentId: 'op1',
      title: 'Untitled',
    });
    // Write more rows than the window; each body is uniquely identifiable.
    const N = CONVERSATION_HISTORY_WINDOW + 10;
    for (let i = 0; i < N; i++) {
      await appendMessage(db, { conversationId: c.id, role: 'user', kind: 'text', body: `msg-${i}` });
    }
    const msgs = await buildConversationMessages(db, c.id);
    // Bounded: never more than the window, regardless of thread length.
    expect(msgs.length).toBeLessThanOrEqual(CONVERSATION_HISTORY_WINDOW);
    // The OLDEST rows are dropped, the most RECENT kept (tail window).
    expect(msgs.some((m) => String(m.content) === 'msg-0')).toBe(false);
    expect(msgs.some((m) => String(m.content) === `msg-${N - 1}`)).toBe(true);
  });

  test('sink writes a tool_step message row', async () => {
    const db = makeDb();
    const c = await createConversation(db, {
      createdBy: 'u1',
      operatorAgentId: 'op1',
      title: 'Untitled',
    });
    const sink = makeConversationSink(db, c.id, 'run-1');
    await sink.toolStep({ tool: 'create_document', summary: 'Created X', status: 'ok' });
    const thread = await getThread(db, c.id);
    expect(thread.at(-1)?.kind).toBe('tool_step');
    expect(thread.at(-1)?.runId).toBe('run-1');
  });

  // Cluster-2 /code-review fix: a FAILED tool_step (status:'error') must persist and
  // replay, so the thread + T8 recovery summary reflect failed attempts, not only
  // successes. The runner now emits these in its recoverable-error branches; this
  // asserts the durable round-trip (write status:'error' -> getThread -> source
  // replays it with the error status visible).
  test('a failed tool_step (status:error) persists and is replayed by the source', async () => {
    const db = makeDb();
    const c = await createConversation(db, {
      createdBy: 'u1',
      operatorAgentId: 'op1',
      title: 'Untitled',
    });
    const sink = makeConversationSink(db, c.id, 'run-1');
    await sink.toolStep({ tool: 'update_document', summary: 'document not found', status: 'error' });
    const thread = await getThread(db, c.id);
    const row = thread.at(-1);
    expect(row?.kind).toBe('tool_step');
    expect(JSON.parse(row!.payload!).status).toBe('error');
    // the source replays the failed step (so the model/human sees it on resume)
    const msgs = await buildConversationMessages(db, c.id);
    expect(msgs.some((m) => String(m.content).includes('error'))).toBe(true);
  });
});
