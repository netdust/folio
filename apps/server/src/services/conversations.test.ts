import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { resolve } from 'node:path';
import * as schema from '../db/schema.ts';
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
});
