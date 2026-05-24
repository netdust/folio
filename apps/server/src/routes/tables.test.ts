import { test, expect } from 'bun:test';
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
  const { app, seed } = await makeTestApp(); // no defaults
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
