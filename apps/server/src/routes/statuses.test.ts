import { test, expect } from 'bun:test';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { makeTestApp } from '../test/harness.ts';
import { apiTokens, documents, events, statuses } from '../db/schema.ts';
import { newApiToken } from '../lib/auth.ts';

const base = '/api/v1/w/acme/p/web/statuses';

async function createStatus(app: Awaited<ReturnType<typeof makeTestApp>>['app'], cookie: string, body: object) {
  return app.request('/api/v1/w/acme/p/web/statuses', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('GET / returns empty list when project has no statuses', async () => {
  const { app, db, seed } = await makeTestApp();
  // Default-table is seeded with 4 statuses; clear them so this test exercises
  // the empty-list branch against the Work Items table.
  await db.delete(statuses);
  const res = await app.request('/api/v1/w/acme/p/web/statuses', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  expect((await res.json()).data).toEqual([]);
});

test('GET / returns the 4 default statuses on a freshly-seeded project', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/p/web/statuses', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const keys = (await res.json()).data.map((s: { key: string }) => s.key).sort();
  expect(keys).toEqual(['backlog', 'done', 'in_progress', 'todo']);
});

test('POST / creates a status', async () => {
  const { app, db, seed } = await makeTestApp();
  await db.delete(statuses); // start clean so 'todo' is free
  const res = await createStatus(app, seed.sessionCookie, {
    key: 'todo', name: 'Todo', category: 'unstarted', order: 10,
  });
  expect(res.status).toBe(201);
  expect((await res.json()).data.status.key).toBe('todo');
});

test('POST duplicate key → 409 SLUG_CONFLICT', async () => {
  const { app, db, seed } = await makeTestApp();
  await db.delete(statuses);
  await createStatus(app, seed.sessionCookie, { key: 'todo', name: 'Todo' });
  const dupe = await createStatus(app, seed.sessionCookie, { key: 'todo', name: 'Todo 2' });
  expect(dupe.status).toBe(409);
  expect((await dupe.json()).error.code).toBe('SLUG_CONFLICT');
});

test('PATCH /:id renames key + cascades to documents in the table', async () => {
  const { app, db, seed } = await makeTestApp();
  await db.delete(statuses);
  const create = await createStatus(app, seed.sessionCookie, { key: 'todo', name: 'Todo' });
  const { data: { status } } = await create.json();
  await db.insert(documents).values({
    id: nanoid(), projectId: seed.project.id, workspaceId: seed.workspace.id, tableId: status.tableId, type: 'work_item',
    slug: 'a', title: 'A', status: 'todo',
  });
  const res = await app.request(`/api/v1/w/acme/p/web/statuses/${status.id}`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'todo-2' }),
  });
  expect(res.status).toBe(200);
  const docs = await db.select().from(documents);
  expect(docs[0]!.status).toBe('todo-2');
});

test('DELETE /:id 409 when status in use', async () => {
  const { app, db, seed } = await makeTestApp();
  await db.delete(statuses);
  const create = await createStatus(app, seed.sessionCookie, { key: 'todo', name: 'Todo' });
  const { data: { status } } = await create.json();
  await db.insert(documents).values({
    id: nanoid(), projectId: seed.project.id, workspaceId: seed.workspace.id, tableId: status.tableId, type: 'work_item',
    slug: 'a', title: 'A', status: 'todo',
  });
  const res = await app.request(`/api/v1/w/acme/p/web/statuses/${status.id}`, {
    method: 'DELETE', headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(409);
  expect((await res.json()).error.code).toBe('STATUS_IN_USE');
});

test('DELETE /:id 204 when unused', async () => {
  const { app, db, seed } = await makeTestApp();
  await db.delete(statuses);
  const create = await createStatus(app, seed.sessionCookie, { key: 'todo', name: 'Todo' });
  const { data: { status } } = await create.json();
  const res = await app.request(`/api/v1/w/acme/p/web/statuses/${status.id}`, {
    method: 'DELETE', headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(204);
});

// --- Phase 2 (operator): config:write guard + dryRun (P2-2/4/6/8) ---

async function mintTokens(db: Awaited<ReturnType<typeof makeTestApp>>['db'], seed: Awaited<ReturnType<typeof makeTestApp>>['seed']) {
  const cw = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    name: 'config-write',
    tokenHash: cw.hash,
    scopes: ['config:write', 'documents:read'],
    createdBy: seed.user.id,
  });
  const dw = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    name: 'docs-write',
    tokenHash: dw.hash,
    scopes: ['documents:write', 'documents:read'],
    createdBy: seed.user.id,
  });
  return { configWriteToken: cw.token, docsWriteToken: dw.token };
}

async function statusCount(db: Awaited<ReturnType<typeof makeTestApp>>['db'], projectId: string): Promise<number> {
  return (await db.select().from(statuses).where(eq(statuses.projectId, projectId))).length;
}

async function eventCount(db: Awaited<ReturnType<typeof makeTestApp>>['db']): Promise<number> {
  return (await db.select().from(events)).length;
}

test('POST /statuses: config:write token creates a status', async () => {
  const { app, db, seed } = await makeTestApp();
  const { configWriteToken } = await mintTokens(db, seed);
  const res = await app.request(base, {
    method: 'POST',
    headers: { Authorization: `Bearer ${configWriteToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'in_review', name: 'In Review' }),
  });
  expect(res.status).toBe(201);
  expect((await res.json()).data.status.key).toBe('in_review');
});

test('POST /statuses: documents:write token cannot create a status (403)', async () => {
  const { app, db, seed } = await makeTestApp();
  const { docsWriteToken } = await mintTokens(db, seed);
  const res = await app.request(base, {
    method: 'POST',
    headers: { Authorization: `Bearer ${docsWriteToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'in_review', name: 'In Review' }),
  });
  expect(res.status).toBe(403);
});

test('POST /statuses: dryRun create does not mutate', async () => {
  const { app, db, seed } = await makeTestApp();
  const { configWriteToken } = await mintTokens(db, seed);
  const beforeStatuses = await statusCount(db, seed.project.id);
  const beforeEvents = await eventCount(db);
  const res = await app.request(base, {
    method: 'POST',
    headers: { Authorization: `Bearer ${configWriteToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'preview', name: 'Preview', dryRun: true }),
  });
  expect(res.status).toBe(200);
  const data = (await res.json()).data;
  expect(data.dry_run).toBe(true);
  expect(data.would).toBe('create');
  expect(data.resource.key).toBe('preview');
  expect(await statusCount(db, seed.project.id)).toBe(beforeStatuses);
  expect(await eventCount(db)).toBe(beforeEvents);
});

test('DELETE /statuses: dryRun delete on missing status 404s', async () => {
  const { app, db, seed } = await makeTestApp();
  const { configWriteToken } = await mintTokens(db, seed);
  const res = await app.request(`${base}/does-not-exist?dryRun=true`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${configWriteToken}` },
  });
  expect(res.status).toBe(404);
});

test('DELETE /statuses: dryRun delete does not mutate an existing status', async () => {
  const { app, db, seed } = await makeTestApp();
  const { configWriteToken } = await mintTokens(db, seed);
  const created = await (
    await app.request(base, {
      method: 'POST',
      headers: { Authorization: `Bearer ${configWriteToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'keepme', name: 'Keep Me' }),
    })
  ).json();
  const id = created.data.status.id as string;
  const beforeStatuses = await statusCount(db, seed.project.id);
  const beforeEvents = await eventCount(db);

  const res = await app.request(`${base}/${id}?dryRun=true`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${configWriteToken}` },
  });
  expect(res.status).toBe(200);
  const data = (await res.json()).data;
  expect(data.dry_run).toBe(true);
  expect(data.would).toBe('delete');
  expect(await statusCount(db, seed.project.id)).toBe(beforeStatuses);
  expect(await eventCount(db)).toBe(beforeEvents);
});
