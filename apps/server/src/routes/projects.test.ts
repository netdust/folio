import { test, expect } from 'bun:test';
import { makeTestApp } from '../test/harness.ts';

test('GET /w/:wslug/projects lists projects in workspace', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/projects', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.map((p: { slug: string }) => p.slug)).toEqual(['web']);
});

test('POST /w/:wslug/projects with explicit slug', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/projects', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Mobile', slug: 'mobile' }),
  });
  expect(res.status).toBe(201);
  expect((await res.json()).data.project.slug).toBe('mobile');
});

test('POST 409 on duplicate slug', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/projects', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Web Again', slug: 'web' }),
  });
  expect(res.status).toBe(409);
  expect((await res.json()).error.code).toBe('SLUG_CONFLICT');
});

test('POST derives unique slug when omitted', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/projects', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Web' }),
  });
  expect(res.status).toBe(201);
  expect((await res.json()).data.project.slug).toBe('web-2');
});

test('GET /w/:wslug/projects/:pslug returns the project', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/projects/web', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  expect((await res.json()).data.project.slug).toBe('web');
});

test('PATCH /w/:wslug/projects/:pslug renames', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/projects/web', {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Webapp' }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).data.project.name).toBe('Webapp');
});

test('DELETE /w/:wslug/projects/:pslug (owner) returns 204', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/projects/web', {
    method: 'DELETE',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(204);
});

test('GET unknown project → 404 PROJECT_NOT_FOUND', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/projects/nope', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(404);
  expect((await res.json()).error.code).toBe('PROJECT_NOT_FOUND');
});

test('POST seeds 4 statuses and 2 views', async () => {
  const { app, db, seed } = await makeTestApp();
  const { statuses, views } = await import('../db/schema.ts');
  const { eq } = await import('drizzle-orm');
  const create = await app.request('/api/v1/w/acme/projects', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Mobile' }),
  });
  const { data: { project } } = await create.json();
  const s = await db.select().from(statuses).where(eq(statuses.projectId, project.id));
  const v = await db.select().from(views).where(eq(views.projectId, project.id));
  expect(s).toHaveLength(4);
  expect(v).toHaveLength(2);
});
