import { test, expect } from 'bun:test';
import { makeTestApp } from '../test/harness.ts';

const path = '/api/v1/w/acme/p/web/documents';

async function createStatus(app: Awaited<ReturnType<typeof makeTestApp>>['app'], cookie: string, key: string) {
  return app.request('/api/v1/w/acme/p/web/statuses', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, name: key }),
  });
}

test('POST /documents JSON creates work_item with derived slug', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'Fix the bug' }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.data.document.slug).toBe('fix-the-bug');
  expect(body.data.document.type).toBe('work_item');
});

test('POST 422 INVALID_STATUS when status not in registry', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'work_item', title: 'X',
      frontmatter: { status: 'nope' },
    }),
  });
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('INVALID_STATUS');
});

test('POST with valid status persists status column', async () => {
  const { app, seed } = await makeTestApp();
  await createStatus(app, seed.sessionCookie, 'todo');
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'Y', frontmatter: { status: 'todo' } }),
  });
  expect(res.status).toBe(201);
  expect((await res.json()).data.document.status).toBe('todo');
});

test('GET /documents/:slug returns the doc', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'A doc' }),
  });
  const res = await app.request(`${path}/a-doc`, { headers: { Cookie: seed.sessionCookie } });
  expect(res.status).toBe(200);
  expect((await res.json()).data.document.title).toBe('A doc');
});

test('GET unknown slug 404 DOCUMENT_NOT_FOUND', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(`${path}/nope`, { headers: { Cookie: seed.sessionCookie } });
  expect(res.status).toBe(404);
  expect((await res.json()).error.code).toBe('DOCUMENT_NOT_FOUND');
});

test('PATCH JSON merges frontmatter', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'work_item', title: 'M',
      frontmatter: { priority: 'high', tag: 'a' },
    }),
  });
  const patch = await app.request(`${path}/m`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ frontmatter: { priority: 'urgent', tag: null } }),
  });
  expect(patch.status).toBe(200);
  const body = await patch.json();
  expect(body.data.document.frontmatter.priority).toBe('urgent');
  expect(body.data.document.frontmatter.tag).toBeUndefined();
});

test('DELETE returns 204', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'Del' }),
  });
  const res = await app.request(`${path}/del`, {
    method: 'DELETE', headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(204);
});

test('POST duplicate title gets unique slug suffix', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'Same' }),
  });
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'Same' }),
  });
  expect((await res.json()).data.document.slug).toBe('same-2');
});
