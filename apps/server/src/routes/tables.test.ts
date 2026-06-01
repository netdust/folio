import { test, expect } from 'bun:test';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { apiTokens, events, tables } from '../db/schema.ts';
import { newApiToken } from '../lib/auth.ts';
import { makeTestApp } from '../test/harness.ts';

const base = '/api/v1/w/acme/p/web/tables';

test('GET /tables returns the default Work Items table when project is seeded', async () => {
  const { app, seed } = await makeTestApp({ seedProjectDefaults: true });
  const res = await app.request(base, { headers: { Cookie: seed.sessionCookie } });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data).toHaveLength(1);
  expect(body.data[0]).toMatchObject({ slug: 'work-items', name: 'Work Items' });
});

test('GET /tables returns empty array when project has no tables', async () => {
  // Opt out of the harness default seed so this test exercises the empty-list branch.
  const { app, seed } = await makeTestApp({ seedProjectDefaults: false });
  const res = await app.request(base, { headers: { Cookie: seed.sessionCookie } });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data).toEqual([]);
});

test('POST /tables creates a new table with derived slug', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(base, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Hot Leads' }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.data).toMatchObject({ slug: 'hot-leads', name: 'Hot Leads' });
});

test('POST /tables accepts an explicit slug', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(base, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Bugs', slug: 'bugs' }),
  });
  expect(res.status).toBe(201);
  expect((await res.json()).data.slug).toBe('bugs');
});

test('POST /tables auto-disambiguates a colliding derived slug', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(base, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Tasks' }),
  });
  const res = await app.request(base, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Tasks' }),
  });
  expect(res.status).toBe(201);
  expect((await res.json()).data.slug).toBe('tasks-2');
});

test('POST /tables 409 SLUG_TAKEN when explicit slug collides', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(base, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Bugs', slug: 'bugs' }),
  });
  const res = await app.request(base, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Bugs Again', slug: 'bugs' }),
  });
  expect(res.status).toBe(409);
  expect((await res.json()).error.code).toBe('SLUG_TAKEN');
});

test('PATCH /tables/:tslug renames the table', async () => {
  const { app, seed } = await makeTestApp({ seedProjectDefaults: true });
  const res = await app.request(`${base}/work-items`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Tickets' }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).data.name).toBe('Tickets');
});

test('PATCH /tables/:tslug ignores slug field (immutable)', async () => {
  const { app, seed } = await makeTestApp({ seedProjectDefaults: true });
  const res = await app.request(`${base}/work-items`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: 'renamed' }),
  });
  // Zod strict schema accepts unknown keys by stripping them, so the request succeeds
  // but the slug stays unchanged. Use the GET to confirm.
  expect(res.status).toBe(200);
  const list = await app.request(base, { headers: { Cookie: seed.sessionCookie } });
  const data = (await list.json()).data;
  expect(data[0].slug).toBe('work-items');
});

test('PATCH /tables/:tslug 404 on unknown slug', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(`${base}/nope`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'X' }),
  });
  expect(res.status).toBe(404);
  expect((await res.json()).error.code).toBe('TABLE_NOT_FOUND');
});

test('DELETE /tables/:tslug returns 204', async () => {
  const { app, seed } = await makeTestApp();
  const created = await (
    await app.request(base, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Temp' }),
    })
  ).json();

  const del = await app.request(`${base}/${created.data.slug}`, {
    method: 'DELETE',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(del.status).toBe(204);
});

test('DELETE /tables/:tslug 404 on unknown', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(`${base}/nope`, {
    method: 'DELETE',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(404);
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

async function tableCount(db: Awaited<ReturnType<typeof makeTestApp>>['db'], projectId: string): Promise<number> {
  return (await db.select().from(tables).where(eq(tables.projectId, projectId))).length;
}

async function eventCount(db: Awaited<ReturnType<typeof makeTestApp>>['db']): Promise<number> {
  return (await db.select().from(events)).length;
}

test('POST /tables: config:write token creates a table', async () => {
  const { app, db, seed } = await makeTestApp();
  const { configWriteToken } = await mintTokens(db, seed);
  const res = await app.request(base, {
    method: 'POST',
    headers: { Authorization: `Bearer ${configWriteToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Sprints' }),
  });
  expect(res.status).toBe(201);
  expect((await res.json()).data).toMatchObject({ slug: 'sprints', name: 'Sprints' });
});

test('POST /tables: documents:write token cannot create a table (403)', async () => {
  const { app, db, seed } = await makeTestApp();
  const { docsWriteToken } = await mintTokens(db, seed);
  const res = await app.request(base, {
    method: 'POST',
    headers: { Authorization: `Bearer ${docsWriteToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Sprints' }),
  });
  expect(res.status).toBe(403);
});

test('POST /tables: dryRun create does not mutate', async () => {
  const { app, db, seed } = await makeTestApp();
  const { configWriteToken } = await mintTokens(db, seed);
  const beforeTables = await tableCount(db, seed.project.id);
  const beforeEvents = await eventCount(db);
  const res = await app.request(base, {
    method: 'POST',
    headers: { Authorization: `Bearer ${configWriteToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Preview', dryRun: true }),
  });
  expect(res.status).toBe(200);
  const data = (await res.json()).data;
  expect(data.dry_run).toBe(true);
  expect(data.would).toBe('create');
  expect(data.resource.name).toBe('Preview');
  expect(await tableCount(db, seed.project.id)).toBe(beforeTables);
  expect(await eventCount(db)).toBe(beforeEvents);
});

test('DELETE /tables: dryRun delete on missing table 404s', async () => {
  const { app, db, seed } = await makeTestApp();
  const { configWriteToken } = await mintTokens(db, seed);
  const res = await app.request(`${base}/does-not-exist?dryRun=true`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${configWriteToken}` },
  });
  expect(res.status).toBe(404);
});

test('DELETE /tables: dryRun delete does not mutate an existing table', async () => {
  const { app, db, seed } = await makeTestApp();
  const { configWriteToken } = await mintTokens(db, seed);
  const created = await (
    await app.request(base, {
      method: 'POST',
      headers: { Authorization: `Bearer ${configWriteToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Keepme' }),
    })
  ).json();
  const slug = created.data.slug as string;
  const beforeTables = await tableCount(db, seed.project.id);
  const beforeEvents = await eventCount(db);

  const res = await app.request(`${base}/${slug}?dryRun=true`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${configWriteToken}` },
  });
  expect(res.status).toBe(200);
  const data = (await res.json()).data;
  expect(data.dry_run).toBe(true);
  expect(data.would).toBe('delete');
  expect(await tableCount(db, seed.project.id)).toBe(beforeTables);
  expect(await eventCount(db)).toBe(beforeEvents);
});
