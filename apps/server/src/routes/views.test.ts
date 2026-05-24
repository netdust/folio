import { test, expect } from 'bun:test';
import { makeTestApp } from '../test/harness.ts';
import { views } from '../db/schema.ts';

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
