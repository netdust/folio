import { test, expect } from 'bun:test';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { makeTestApp } from '../test/harness.ts';
import { apiTokens, events, views } from '../db/schema.ts';
import { newApiToken } from '../lib/auth.ts';

const path = '/api/v1/w/acme/p/web/views';

test('GET / returns empty when the table has no views', async () => {
  const { app, db, seed } = await makeTestApp();
  // The default Work Items table seeds 2 views ("All work items", "Board").
  // Drop them so this test asserts the empty-list branch.
  await db.delete(views);
  const res = await app.request(path, { headers: { Cookie: seed.sessionCookie } });
  expect(res.status).toBe(200);
  expect((await res.json()).data).toEqual([]);
});

test('GET / returns the 2 default views on a freshly-seeded project', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, { headers: { Cookie: seed.sessionCookie } });
  expect(res.status).toBe(200);
  const names = (await res.json()).data.map((v: { name: string }) => v.name).sort();
  expect(names).toEqual(['All work items', 'Board']);
});

test('POST creates a list view with filters', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Mine', type: 'list',
      filters: { assignee: 'alice@test.local' },
    }),
  });
  expect(res.status).toBe(201);
});

test('POST 422 INVALID_FILTER on bad operator', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Bad', type: 'list',
      filters: { x: { $bogus: 1 } },
    }),
  });
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('INVALID_FILTER');
});

test('PATCH /:id renames', async () => {
  const { app, seed } = await makeTestApp();
  const create = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'X', type: 'list' }),
  });
  const { data: { view } } = await create.json();
  const res = await app.request(`${path}/${view.id}`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Y' }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).data.view.name).toBe('Y');
});

test('DELETE /:id 204', async () => {
  const { app, seed } = await makeTestApp();
  const create = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Z', type: 'list' }),
  });
  const { data: { view } } = await create.json();
  const res = await app.request(`${path}/${view.id}`, {
    method: 'DELETE', headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(204);
});

test('POST /views accepts columnOrder and round-trips it', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(`/api/v1/w/acme/p/web/views`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'With order',
      type: 'list',
      visibleFields: ['title', 'status', 'amount'],
      columnOrder: ['title', 'amount', 'status'],
    }),
  });
  expect(res.status).toBe(201);
  const created = await res.json();
  const id = (created.data?.view ?? created.data ?? created.view).id;
  const get = await app.request(`/api/v1/w/acme/p/web/views`, { headers: { Cookie: seed.sessionCookie } });
  const list = await get.json();
  const row = list.data.find((v: { id: string }) => v.id === id);
  expect(row.columnOrder).toEqual(['title', 'amount', 'status']);
});

test('PATCH /views/:id accepts columnOrder updates', async () => {
  const { app, seed } = await makeTestApp();
  const created = await (await app.request(`/api/v1/w/acme/p/web/views`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'V', type: 'list' }),
  })).json();
  const id = (created.data?.view ?? created.data ?? created.view).id;
  const res = await app.request(`/api/v1/w/acme/p/web/views/${id}`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnOrder: ['status', 'title'] }),
  });
  expect(res.status).toBe(200);
});

test('POST returns data.view.id as a unique non-empty string', async () => {
  const { app, seed } = await makeTestApp();
  // First create
  const a = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Id contract A',
      type: 'list',
      filters: {},
      sort: [],
      visibleFields: ['title', 'status'],
      columnOrder: ['title', 'status'],
    }),
  });
  expect(a.status).toBe(201);
  const aId = (await a.json()).data.view.id;
  expect(typeof aId).toBe('string');
  expect(aId.length).toBeGreaterThan(0);

  // Second create — must produce a different id
  const b = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Id contract B', type: 'list' }),
  });
  expect(b.status).toBe(201);
  const bId = (await b.json()).data.view.id;
  expect(typeof bId).toBe('string');
  expect(bId.length).toBeGreaterThan(0);
  expect(bId).not.toBe(aId);
});

// --- Phase 2 (operator): config:write guard + dryRun (P2-2/3/4/6/8) ---

async function mintTokens(
  db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  seed: Awaited<ReturnType<typeof makeTestApp>>['seed'],
) {
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

async function viewCount(
  db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  projectId: string,
): Promise<number> {
  return (await db.select().from(views).where(eq(views.projectId, projectId))).length;
}

async function eventCount(db: Awaited<ReturnType<typeof makeTestApp>>['db']): Promise<number> {
  return (await db.select().from(events)).length;
}

test('POST /views: config:write token creates a view', async () => {
  const { app, db, seed } = await makeTestApp();
  const { configWriteToken } = await mintTokens(db, seed);
  const res = await app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${configWriteToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'My View', type: 'list' }),
  });
  expect(res.status).toBe(201);
  expect((await res.json()).data.view.name).toBe('My View');
});

test('POST /views: documents:write token cannot create a view (403)', async () => {
  const { app, db, seed } = await makeTestApp();
  const { docsWriteToken } = await mintTokens(db, seed);
  const res = await app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${docsWriteToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'My View', type: 'list' }),
  });
  expect(res.status).toBe(403);
});

test('POST /views: dryRun create does not mutate', async () => {
  const { app, db, seed } = await makeTestApp();
  const { configWriteToken } = await mintTokens(db, seed);
  const beforeViews = await viewCount(db, seed.project.id);
  const beforeEvents = await eventCount(db);
  const res = await app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${configWriteToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Preview', type: 'list', dryRun: true }),
  });
  expect(res.status).toBe(200);
  const data = (await res.json()).data;
  expect(data.dry_run).toBe(true);
  expect(data.would).toBe('create');
  expect(data.resource.view.name).toBe('Preview');
  expect(await viewCount(db, seed.project.id)).toBe(beforeViews);
  expect(await eventCount(db)).toBe(beforeEvents);
});

test('DELETE /views: dryRun delete on missing view 404s', async () => {
  const { app, db, seed } = await makeTestApp();
  const { configWriteToken } = await mintTokens(db, seed);
  const res = await app.request(`${path}/does-not-exist?dryRun=true`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${configWriteToken}` },
  });
  expect(res.status).toBe(404);
});

test('DELETE /views: dryRun delete does not mutate an existing view', async () => {
  const { app, db, seed } = await makeTestApp();
  const { configWriteToken } = await mintTokens(db, seed);
  const created = await (
    await app.request(path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${configWriteToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Keepme', type: 'list' }),
    })
  ).json();
  const id = created.data.view.id as string;
  const beforeViews = await viewCount(db, seed.project.id);
  const beforeEvents = await eventCount(db);

  const res = await app.request(`${path}/${id}?dryRun=true`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${configWriteToken}` },
  });
  expect(res.status).toBe(200);
  const data = (await res.json()).data;
  expect(data.dry_run).toBe(true);
  expect(data.would).toBe('delete');
  expect(await viewCount(db, seed.project.id)).toBe(beforeViews);
  expect(await eventCount(db)).toBe(beforeEvents);
});

test('POST /views: dryRun resource matches the live created view (minus id)', async () => {
  const { app, db, seed } = await makeTestApp();
  const { configWriteToken } = await mintTokens(db, seed);
  const body = {
    name: 'Shape parity',
    type: 'list' as const,
    filters: { assignee: 'alice@test.local' },
  };

  const live = await (
    await app.request(path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${configWriteToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  ).json();
  const dry = await (
    await app.request(path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${configWriteToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, dryRun: true }),
    })
  ).json();

  // P2-3: the dryRun resource equals the live success `data` (same wrapper key),
  // minus the volatile id. Proves the preview shape matches the real response.
  const { id: _liveId, ...liveRow } = live.data.view;
  const { id: _dryId, ...dryRow } = dry.data.resource.view;
  expect(dryRow).toEqual(liveRow);
});
