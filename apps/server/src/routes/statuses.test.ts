import { test, expect } from 'bun:test';
import { nanoid } from 'nanoid';
import { makeTestApp } from '../test/harness.ts';
import { documents, statuses } from '../db/schema.ts';

async function createStatus(app: Awaited<ReturnType<typeof makeTestApp>>['app'], cookie: string, body: object) {
  return app.request('/api/v1/w/acme/p/web/statuses', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('GET / returns empty list initially', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/p/web/statuses', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  expect((await res.json()).data).toEqual([]);
});

test('POST / creates a status', async () => {
  const { app, seed } = await makeTestApp();
  const res = await createStatus(app, seed.sessionCookie, {
    key: 'todo', name: 'Todo', category: 'unstarted', order: 10,
  });
  expect(res.status).toBe(201);
  expect((await res.json()).data.status.key).toBe('todo');
});

test('POST duplicate key → 409 SLUG_CONFLICT', async () => {
  const { app, seed } = await makeTestApp();
  await createStatus(app, seed.sessionCookie, { key: 'todo', name: 'Todo' });
  const dupe = await createStatus(app, seed.sessionCookie, { key: 'todo', name: 'Todo 2' });
  expect(dupe.status).toBe(409);
  expect((await dupe.json()).error.code).toBe('SLUG_CONFLICT');
});

test('PATCH /:id renames key + cascades to documents', async () => {
  const { app, db, seed } = await makeTestApp();
  const create = await createStatus(app, seed.sessionCookie, { key: 'todo', name: 'Todo' });
  const { data: { status } } = await create.json();
  await db.insert(documents).values({
    id: nanoid(), projectId: seed.project.id, type: 'work_item',
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
  const create = await createStatus(app, seed.sessionCookie, { key: 'todo', name: 'Todo' });
  const { data: { status } } = await create.json();
  await db.insert(documents).values({
    id: nanoid(), projectId: seed.project.id, type: 'work_item',
    slug: 'a', title: 'A', status: 'todo',
  });
  const res = await app.request(`/api/v1/w/acme/p/web/statuses/${status.id}`, {
    method: 'DELETE', headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(409);
  expect((await res.json()).error.code).toBe('STATUS_IN_USE');
});

test('DELETE /:id 204 when unused', async () => {
  const { app, seed } = await makeTestApp();
  const create = await createStatus(app, seed.sessionCookie, { key: 'todo', name: 'Todo' });
  const { data: { status } } = await create.json();
  const res = await app.request(`/api/v1/w/acme/p/web/statuses/${status.id}`, {
    method: 'DELETE', headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(204);
});
