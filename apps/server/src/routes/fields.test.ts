import { test, expect } from 'bun:test';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { apiTokens, events, fields } from '../db/schema.ts';
import { newApiToken } from '../lib/auth.ts';
import { makeTestApp } from '../test/harness.ts';

const path = '/api/v1/w/acme/p/web/fields';

test('GET / empty initially', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, { headers: { Cookie: seed.sessionCookie } });
  expect(res.status).toBe(200);
  expect((await res.json()).data).toEqual([]);
});

test('POST creates a select field with options', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'priority', type: 'select', options: ['low', 'med', 'high'] }),
  });
  expect(res.status).toBe(201);
});

test('POST 422 when select has no options', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'priority', type: 'select' }),
  });
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('INVALID_BODY');
});

test('POST 422 when text has options', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'note', type: 'text', options: ['x'] }),
  });
  expect(res.status).toBe(422);
});

test('PATCH type change preserves row', async () => {
  const { app, seed } = await makeTestApp();
  const create = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'priority', type: 'string' }),
  });
  const { data: { field } } = await create.json();
  const patch = await app.request(`${path}/${field.id}`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'text' }),
  });
  expect(patch.status).toBe(200);
  expect((await patch.json()).data.field.type).toBe('text');
});

test('DELETE drops the pin', async () => {
  const { app, seed } = await makeTestApp();
  const create = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'priority', type: 'string' }),
  });
  const { data: { field } } = await create.json();
  const res = await app.request(`${path}/${field.id}`, {
    method: 'DELETE', headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(204);
});

test('POST /fields accepts type=currency with a single ISO-4217 option', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(`/api/v1/w/acme/p/web/fields`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'amount', type: 'currency', options: ['EUR'] }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  const field = body.data?.field ?? body.data ?? body.field;
  expect(field.type).toBe('currency');
  expect(field.options).toEqual(['EUR']);
});

test('POST /fields 422 on currency without options', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(`/api/v1/w/acme/p/web/fields`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'amount', type: 'currency' }),
  });
  expect(res.status).toBe(422);
});

test('POST /fields 422 on currency with non-ISO code', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(`/api/v1/w/acme/p/web/fields`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'amount', type: 'currency', options: ['euro'] }),
  });
  expect(res.status).toBe(422);
});

test('POST /fields 422 on relation without options', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'rel_a', type: 'relation' }),
  });
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('INVALID_BODY');
});

test('POST /fields 422 on relation with bad cardinality', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'rel_b', type: 'relation', options: ['wiki', 'lots'] }),
  });
  expect(res.status).toBe(422);
});

test('POST /fields accepts relation [wiki, single]', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'rel_c', type: 'relation', options: ['wiki', 'single'] }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  const field = body.data?.field ?? body.data ?? body.field;
  expect(field.type).toBe('relation');
  expect(field.options).toEqual(['wiki', 'single']);
});

test('POST /fields accepts relation [table:<id>, multi]', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'rel_d', type: 'relation', options: ['table:tbl_abc', 'multi'] }),
  });
  expect(res.status).toBe(201);
});

test('POST /fields 422 on relation with bad target', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'rel_e', type: 'relation', options: ['garbage', 'single'] }),
  });
  expect(res.status).toBe(422);
});

test('PATCH allows compatible string→text', async () => {
  const { app, seed } = await makeTestApp();
  const create = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'note', type: 'string' }),
  });
  const { data: { field } } = await create.json();
  const patch = await app.request(`${path}/${field.id}`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'text' }),
  });
  expect(patch.status).toBe(200);
  expect((await patch.json()).data.field.type).toBe('text');
});

test('PATCH rejects incompatible number→select with 422 INVALID_TYPE_CHANGE', async () => {
  const { app, seed } = await makeTestApp();
  const create = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'qty', type: 'number' }),
  });
  const { data: { field } } = await create.json();
  const patch = await app.request(`${path}/${field.id}`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'select', options: ['a', 'b'] }),
  });
  expect(patch.status).toBe(422);
  const body = await patch.json();
  expect(body.error.code).toBe('INVALID_TYPE_CHANGE');
  expect(body.error.message).toContain('number → select');
});

test('PATCH any→text always allowed (date→text)', async () => {
  const { app, seed } = await makeTestApp();
  const create = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'due', type: 'date' }),
  });
  const { data: { field } } = await create.json();
  const patch = await app.request(`${path}/${field.id}`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'text' }),
  });
  expect(patch.status).toBe(200);
  expect((await patch.json()).data.field.type).toBe('text');
});

test('PATCH number→currency auto-injects [EUR] when no options supplied', async () => {
  const { app, seed } = await makeTestApp();
  const create = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'amount', type: 'number' }),
  });
  const { data: { field } } = await create.json();
  const patch = await app.request(`${path}/${field.id}`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'currency' }),
  });
  expect(patch.status).toBe(200);
  const body = await patch.json();
  expect(body.data.field.type).toBe('currency');
  expect(body.data.field.options).toEqual(['EUR']);
});

test('PATCH currency→number clears options when client sends options: null', async () => {
  const { app, seed } = await makeTestApp();
  const create = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'amount', type: 'currency', options: ['EUR'] }),
  });
  const { data: { field } } = await create.json();

  const patch = await app.request(`${path}/${field.id}`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'number', options: null }),
  });
  expect(patch.status).toBe(200);
  const body = await patch.json();
  expect(body.data.field.type).toBe('number');
  expect(body.data.field.options).toBeNull();
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

async function fieldCount(db: Awaited<ReturnType<typeof makeTestApp>>['db'], projectId: string): Promise<number> {
  return (await db.select().from(fields).where(eq(fields.projectId, projectId))).length;
}

async function eventCount(db: Awaited<ReturnType<typeof makeTestApp>>['db']): Promise<number> {
  return (await db.select().from(events)).length;
}

test('POST /fields: config:write token creates a field', async () => {
  const { app, db, seed } = await makeTestApp();
  const { configWriteToken } = await mintTokens(db, seed);
  const res = await app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${configWriteToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'priority', type: 'text' }),
  });
  expect(res.status).toBe(201);
  expect((await res.json()).data.field.key).toBe('priority');
});

test('POST /fields: documents:write token cannot create a field (403)', async () => {
  const { app, db, seed } = await makeTestApp();
  const { docsWriteToken } = await mintTokens(db, seed);
  const res = await app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${docsWriteToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'priority', type: 'text' }),
  });
  expect(res.status).toBe(403);
});

test('POST /fields: dryRun create does not mutate', async () => {
  const { app, db, seed } = await makeTestApp();
  const { configWriteToken } = await mintTokens(db, seed);
  const beforeFields = await fieldCount(db, seed.project.id);
  const beforeEvents = await eventCount(db);
  const res = await app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${configWriteToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'preview_field', type: 'text', dryRun: true }),
  });
  expect(res.status).toBe(200);
  const data = (await res.json()).data;
  expect(data.dry_run).toBe(true);
  expect(data.would).toBe('create');
  expect(data.resource.key).toBe('preview_field');
  expect(await fieldCount(db, seed.project.id)).toBe(beforeFields);
  expect(await eventCount(db)).toBe(beforeEvents);
});

test('DELETE /fields: dryRun delete on missing field 404s', async () => {
  const { app, db, seed } = await makeTestApp();
  const { configWriteToken } = await mintTokens(db, seed);
  const res = await app.request(`${path}/does-not-exist?dryRun=true`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${configWriteToken}` },
  });
  expect(res.status).toBe(404);
});

test('DELETE /fields: dryRun delete does not mutate an existing field', async () => {
  const { app, db, seed } = await makeTestApp();
  const { configWriteToken } = await mintTokens(db, seed);
  const created = await (
    await app.request(path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${configWriteToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'keepme', type: 'text' }),
    })
  ).json();
  const fieldId = created.data.field.id as string;
  const beforeFields = await fieldCount(db, seed.project.id);
  const beforeEvents = await eventCount(db);

  const res = await app.request(`${path}/${fieldId}?dryRun=true`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${configWriteToken}` },
  });
  expect(res.status).toBe(200);
  const data = (await res.json()).data;
  expect(data.dry_run).toBe(true);
  expect(data.would).toBe('delete');
  expect(await fieldCount(db, seed.project.id)).toBe(beforeFields);
  expect(await eventCount(db)).toBe(beforeEvents);
});
