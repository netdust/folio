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

test('POST text/markdown creates from raw MD with H1 title', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'text/markdown' },
    body: `---
type: work_item
priority: high
---

# Markdown Title

Body here.
`,
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.data.document.title).toBe('Markdown Title');
  expect(body.data.document.frontmatter.priority).toBe('high');
});

test('POST text/markdown without H1 falls back to frontmatter.title', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'text/markdown' },
    body: `---
title: From Frontmatter
type: page
---

Body
`,
  });
  expect(res.status).toBe(201);
  expect((await res.json()).data.document.title).toBe('From Frontmatter');
});

test('POST text/markdown with no title at all gets "Untitled"', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'text/markdown' },
    body: `body only`,
  });
  expect(res.status).toBe(201);
  expect((await res.json()).data.document.title).toBe('Untitled');
});

test('PATCH text/markdown replaces whole document', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'work_item', title: 'Original', frontmatter: { keep: 'me' },
    }),
  });
  const res = await app.request(`${path}/original`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'text/markdown' },
    body: `---
type: work_item
priority: critical
---

# Renamed

New body.
`,
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.document.title).toBe('Renamed');
  expect(body.data.document.frontmatter.priority).toBe('critical');
  expect(body.data.document.frontmatter.keep).toBeUndefined(); // replaced, not merged
});

test('PATCH text/markdown changing type is rejected', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'Stay' }),
  });
  const res = await app.request(`${path}/stay`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'text/markdown' },
    body: `---
type: page
---
# Stay
`,
  });
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('INVALID_BODY');
});

test('GET /documents lists with no filter', async () => {
  const { app, seed } = await makeTestApp();
  for (const t of ['A', 'B', 'C']) {
    await app.request(path, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'work_item', title: t }),
    });
  }
  const res = await app.request(path, { headers: { Cookie: seed.sessionCookie } });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data).toHaveLength(3);
});

test('GET filters by type', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'W' }),
  });
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'page', title: 'P' }),
  });
  const res = await app.request(`${path}?type=page`, { headers: { Cookie: seed.sessionCookie } });
  expect((await res.json()).data).toHaveLength(1);
});

test('GET applies a filter AST via ?filter=', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'X', frontmatter: { priority: 'high' } }),
  });
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'Y', frontmatter: { priority: 'low' } }),
  });
  const filter = encodeURIComponent(JSON.stringify({ priority: 'high' }));
  const res = await app.request(`${path}?filter=${filter}`, {
    headers: { Cookie: seed.sessionCookie },
  });
  const body = await res.json();
  expect(body.data).toHaveLength(1);
  expect(body.data[0].title).toBe('X');
});

test('GET 422 INVALID_FILTER on bad operator', async () => {
  const { app, seed } = await makeTestApp();
  const filter = encodeURIComponent(JSON.stringify({ x: { $bogus: 1 } }));
  const res = await app.request(`${path}?filter=${filter}`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('INVALID_FILTER');
});

test('GET respects limit and returns nextCursor', async () => {
  const { app, seed } = await makeTestApp();
  for (let i = 0; i < 5; i++) {
    await app.request(path, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'work_item', title: `T${i}` }),
    });
  }
  const res = await app.request(`${path}?limit=2`, { headers: { Cookie: seed.sessionCookie } });
  const body = await res.json();
  expect(body.data).toHaveLength(2);
  expect(typeof body.nextCursor).toBe('string');
});
