import { expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  events,
  apiTokens,
  projectAccess,
  projects,
  tables,
  users,
  views,
  workspaceAccess,
} from '../db/schema.ts';
import { createSession, hashPassword, newApiToken } from '../lib/auth.ts';
import { makeTestApp } from '../test/harness.ts';

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
      name: 'Mine',
      type: 'list',
      filters: { assignee: 'alice@test.local' },
    }),
  });
  expect(res.status).toBe(201);
});

test('POST without an explicit order assigns a UNIQUE order (max+10), not 0', async () => {
  // V1 (views UX shake-out): a created view defaulted to order:0, colliding with
  // the default view (order 0) + every other custom view → unstable rail sort that
  // reads as "views duplicated". A new view must get an order BELOW none of the
  // existing ones. Seeded: "All work items"=0, "Board"=10 → new view should be 20.
  const { app, seed } = await makeTestApp();
  const create = async (name: string) => {
    const res = await app.request(path, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type: 'list' }),
    });
    expect(res.status).toBe(201);
    return (await res.json()).data.view as { id: string; order: number };
  };
  const a = await create('First');
  expect(a.order).toBe(20); // max(0,10)+10
  const b = await create('Second');
  expect(b.order).toBe(30); // max(0,10,20)+10 — strictly increasing, no collision
  // No two views share an order.
  const all = await app.request(path, { headers: { Cookie: seed.sessionCookie } });
  const orders = (await all.json()).data.map((v: { order: number }) => v.order);
  expect(new Set(orders).size).toBe(orders.length);
});

test('POST 422 INVALID_FILTER on bad operator', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Bad',
      type: 'list',
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
  const {
    data: { view },
  } = await create.json();
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
  const {
    data: { view },
  } = await create.json();
  const res = await app.request(`${path}/${view.id}`, {
    method: 'DELETE',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(204);
});

test('POST /views accepts columnOrder and round-trips it', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/p/web/views', {
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
  const get = await app.request('/api/v1/w/acme/p/web/views', {
    headers: { Cookie: seed.sessionCookie },
  });
  const list = await get.json();
  const row = list.data.find((v: { id: string }) => v.id === id);
  expect(row.columnOrder).toEqual(['title', 'amount', 'status']);
});

test('PATCH /views/:id accepts columnOrder updates', async () => {
  const { app, seed } = await makeTestApp();
  const created = await (
    await app.request('/api/v1/w/acme/p/web/views', {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'V', type: 'list' }),
    })
  ).json();
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
  // minus the volatile fields. Proves the preview SHAPE matches the real response.
  // `order` is excluded alongside `id`: it's now state-dependent (max+10, V1 fix),
  // so the dryRun AFTER the live create predicts the NEXT order (the live row bumped
  // the max) — correct behavior, but not a parity field across two sequential calls.
  const { id: _liveId, order: _liveOrder, ...liveRow } = live.data.view;
  const { id: _dryId, order: _dryOrder, ...dryRow } = dry.data.resource.view;
  expect(dryRow).toEqual(liveRow);
});

// --- C1 (M3): batched project-views endpoint (collapses the rail P×T fan-out) ---

const batchPath = '/api/v1/w/acme/p/web/views';

/** Add a second table to the seed project and return its id + slug. */
async function addTable(
  db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  projectId: string,
  slug: string,
): Promise<{ id: string; slug: string }> {
  const id = nanoid();
  await db.insert(tables).values({ id, projectId, slug, name: slug });
  return { id, slug };
}

/** Insert a view directly so we can assert grouping without going through POST. */
async function addView(
  db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  projectId: string,
  tableId: string,
  name: string,
  order = 0,
): Promise<string> {
  const id = nanoid();
  await db.insert(views).values({
    id,
    projectId,
    tableId,
    name,
    type: 'list',
    filters: {},
    sort: [],
    groupBy: null,
    visibleFields: [],
    columnOrder: null,
    order,
    isDefault: false,
  });
  return id;
}

test('GET /views?tables= returns views grouped by tableId for the requested tables', async () => {
  const { app, db, seed } = await makeTestApp();
  // Seed table is "work-items" (2 default views). Add a second table with a view.
  const wi = await db.query.tables.findFirst({
    where: eq(tables.projectId, seed.project.id),
  });
  const bugs = await addTable(db, seed.project.id, 'bugs');
  await addView(db, seed.project.id, bugs.id, 'Bug board', 0);

  const res = await app.request(`${batchPath}?tables=work-items,bugs`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const grouped = (await res.json()).data as Record<string, { name: string }[]>;
  // work-items keyed by its id, with the 2 seeded views; bugs keyed by its id.
  expect((grouped[wi!.id] ?? []).map((v) => v.name).sort()).toEqual(['All work items', 'Board']);
  expect((grouped[bugs.id] ?? []).map((v) => v.name)).toEqual(['Bug board']);
});

test('GET /views?tables= scopes to ONE query-shaped grouped object (only requested tables present)', async () => {
  const { app, db, seed } = await makeTestApp();
  const wi = await db.query.tables.findFirst({ where: eq(tables.projectId, seed.project.id) });
  const bugs = await addTable(db, seed.project.id, 'bugs');
  await addView(db, seed.project.id, bugs.id, 'Bug board');

  // Only request work-items — bugs must NOT appear in the response.
  const res = await app.request(`${batchPath}?tables=work-items`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const grouped = (await res.json()).data as Record<string, unknown>;
  expect(Object.keys(grouped)).toEqual([wi!.id]);
  expect(grouped[bugs.id]).toBeUndefined();
});

test('GET /views?tables= (empty value) returns an empty object', async () => {
  // The batched form keys off the PRESENCE of `?tables=`. An empty value (a
  // 0-table project, or a project the rail fetches before tables load) yields a
  // grouped {} — NOT the legacy default-table array (that's the no-param path,
  // which the existing GET / tests still cover).
  const { app, seed } = await makeTestApp();
  const res = await app.request(`${batchPath}?tables=`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  expect((await res.json()).data).toEqual({});
});

test('GET /views?tables= DENIES a cross-project table (not returned)', async () => {
  // A table slug from ANOTHER project must not leak its views through THIS
  // project's batch endpoint, even if the slug exists elsewhere.
  const { app, db, seed } = await makeTestApp();
  // Second project with a table that shares the slug "shared".
  const otherProjId = nanoid();
  await db.insert(projects).values({
    id: otherProjId,
    workspaceId: seed.workspace.id,
    slug: 'other',
    name: 'Other',
  });
  const otherTable = await addTable(db, otherProjId, 'shared');
  await addView(db, otherProjId, otherTable.id, 'Secret view');

  // Request the foreign table's slug against THIS project's endpoint.
  const res = await app.request(`${batchPath}?tables=shared`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const grouped = (await res.json()).data as Record<string, unknown>;
  // The foreign table id must NOT be a key, and the foreign view must not leak.
  expect(grouped[otherTable.id]).toBeUndefined();
  expect(Object.keys(grouped)).toEqual([]);
});

test('GET /views?tables= DENIES a caller with no access to the project (404 via pScope chain)', async () => {
  // The endpoint inherits resolveProject's per-project visibility check. A member
  // with NO project_access grant on a second project is 404'd (existence not leaked).
  const { app, db, seed } = await makeTestApp();
  // Second project the member is NOT granted.
  const projId = nanoid();
  await db.insert(projects).values({
    id: projId,
    workspaceId: seed.workspace.id,
    slug: 'walled',
    name: 'Walled',
  });
  const t = await addTable(db, projId, 'work-items');
  await addView(db, projId, t.id, 'Hidden');

  // A TRAVERSE-only member: a project_access grant on the seed `web` project (so
  // resolveWorkspace passes via the traverse clause) but NO workspace_access and
  // NO grant on `walled` — so canSeeProject(walled) is false → resolveProject
  // 404s. (A ws-grant member would SEE walled via canSeeProject's ws clause, so
  // the denial must come from a project-only invitee.)
  const memberId = nanoid();
  await db.insert(users).values({
    id: memberId,
    email: `${memberId}@test.local`,
    name: 'Mallory',
    passwordHash: await hashPassword('password123'),
  });
  await db.insert(projectAccess).values({ userId: memberId, projectId: seed.project.id });
  const session = await createSession(memberId);
  const memberCookie = `folio_session=${session.id}`;

  const res = await app.request('/api/v1/w/acme/p/walled/views?tables=work-items', {
    headers: { Cookie: memberCookie },
  });
  expect(res.status).toBe(404);
  expect((await res.json()).error.code).toBe('PROJECT_NOT_FOUND');
});

test('GET /views?tables= ALLOWS a member WITH a project_access grant', async () => {
  // Positive companion to the denial: a member granted project_access sees the
  // project's views through the batch endpoint.
  const { app, db, seed } = await makeTestApp();
  const wi = await db.query.tables.findFirst({ where: eq(tables.projectId, seed.project.id) });
  const memberId = nanoid();
  await db.insert(users).values({
    id: memberId,
    email: `${memberId}@test.local`,
    name: 'Grace',
    passwordHash: await hashPassword('password123'),
  });
  await db.insert(workspaceAccess).values({ userId: memberId, workspaceId: seed.workspace.id });
  await db.insert(projectAccess).values({ userId: memberId, projectId: seed.project.id });
  const session = await createSession(memberId);
  const memberCookie = `folio_session=${session.id}`;

  const res = await app.request(`${batchPath}?tables=work-items`, {
    headers: { Cookie: memberCookie },
  });
  expect(res.status).toBe(200);
  const grouped = (await res.json()).data as Record<string, { name: string }[]>;
  expect((grouped[wi!.id] ?? []).map((v) => v.name).sort()).toEqual(['All work items', 'Board']);
});
