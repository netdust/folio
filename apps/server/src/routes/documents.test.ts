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
  expect(body.data.slug).toBe('fix-the-bug');
  expect(body.data.type).toBe('work_item');
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
  expect((await res.json()).data.status).toBe('todo');
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
  expect((await res.json()).data.title).toBe('A doc');
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
  expect(body.data.frontmatter.priority).toBe('urgent');
  expect(body.data.frontmatter.tag).toBeUndefined();
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
  expect((await res.json()).data.slug).toBe('same-2');
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
  expect(body.data.title).toBe('Markdown Title');
  expect(body.data.frontmatter.priority).toBe('high');
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
  expect((await res.json()).data.title).toBe('From Frontmatter');
});

test('POST text/markdown with no title at all gets "Untitled"', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'text/markdown' },
    body: `body only`,
  });
  expect(res.status).toBe(201);
  expect((await res.json()).data.title).toBe('Untitled');
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
  expect(body.data.title).toBe('Renamed');
  expect(body.data.frontmatter.priority).toBe('critical');
  expect(body.data.frontmatter.keep).toBeUndefined(); // replaced, not merged
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

test('GET filters by ?status= (single value)', async () => {
  const { app, seed } = await makeTestApp({ seedProjectDefaults: true });
  // Status is set via frontmatter.status on create, then promoted to a column.
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'TodoDoc', frontmatter: { status: 'todo' } }),
  });
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'BacklogDoc', frontmatter: { status: 'backlog' } }),
  });
  const res = await app.request(`${path}?status=todo`, { headers: { Cookie: seed.sessionCookie } });
  const body = await res.json();
  expect(body.data).toHaveLength(1);
  expect(body.data[0].title).toBe('TodoDoc');
});

test('GET filters by ?status= (multiple values via repeat)', async () => {
  const { app, seed } = await makeTestApp({ seedProjectDefaults: true });
  for (const [t, s] of [['T', 'todo'], ['B', 'backlog'], ['D', 'done']] as const) {
    await app.request(path, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'work_item', title: t, frontmatter: { status: s } }),
    });
  }
  const res = await app.request(`${path}?status=todo&status=done`, { headers: { Cookie: seed.sessionCookie } });
  const body = await res.json();
  expect(body.data).toHaveLength(2);
  const titles = body.data.map((d: { title: string }) => d.title).sort();
  expect(titles).toEqual(['D', 'T']);
});

test('GET filters by ?updated_since=', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'Old' }),
  });
  // Future timestamp filters everything out
  const future = new Date(Date.now() + 60_000).toISOString();
  const res = await app.request(`${path}?updated_since=${future}`, { headers: { Cookie: seed.sessionCookie } });
  expect((await res.json()).data).toHaveLength(0);
});

test('GET filters by ?assignee= against frontmatter', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'Mine', frontmatter: { assignee: 'me' } }),
  });
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'Theirs', frontmatter: { assignee: 'them' } }),
  });
  const res = await app.request(`${path}?assignee=me`, { headers: { Cookie: seed.sessionCookie } });
  const body = await res.json();
  expect(body.data).toHaveLength(1);
  expect(body.data[0].title).toBe('Mine');
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

test('GET /documents/:slug.md returns raw markdown with frontmatter', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'work_item', title: 'Round Trip',
      frontmatter: { priority: 'high', tag: 'a' },
    }),
  });
  const res = await app.request(`${path}/round-trip.md`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/text\/markdown/);
  const text = await res.text();
  expect(text).toMatch(/^---\n/);
  expect(text).toMatch(/title: Round Trip/);
  expect(text).toMatch(/priority: high/);
});

test('GET /documents/:slug.md includes last_touched_at in frontmatter after activity is logged', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'Stamped' }),
  });
  await app.request(`${path}/stamped/activity`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'Pinged' }),
  });

  const res = await app.request(`${path}/stamped.md`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  // "markdown is the source-of-truth surface" wedge — every first-class
  // column must round-trip via the .md export. lastTouchedAt is now one.
  expect(text).toMatch(/last_touched_at:/);
});

test('POST /:slug/activity bumps last_touched_at and emits activity.logged', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'Lead Foo' }),
  });

  const before = await app.request(`${path}/lead-foo`, { headers: { Cookie: seed.sessionCookie } });
  expect((await before.json()).data.lastTouchedAt).toBeNull();

  const res = await app.request(`${path}/lead-foo/activity`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'Called, will follow up Tuesday' }),
  });
  expect(res.status).toBe(201);

  const after = await app.request(`${path}/lead-foo`, { headers: { Cookie: seed.sessionCookie } });
  const afterDoc = (await after.json()).data;
  expect(afterDoc.lastTouchedAt).not.toBeNull();

  const events = await app.request(`${path}/lead-foo/events`, { headers: { Cookie: seed.sessionCookie } });
  const list = (await events.json()).data;
  const activityEvents = list.filter((e: { kind: string }) => e.kind === 'activity.logged');
  expect(activityEvents).toHaveLength(1);
  expect(activityEvents[0].payload).toEqual({ note: 'Called, will follow up Tuesday' });
});

test('POST /:slug/activity bumps documents.updatedAt so the doc surfaces in updated-at sort', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'Touch Me' }),
  });

  const before = await app.request(`${path}/touch-me`, { headers: { Cookie: seed.sessionCookie } });
  const beforeUpdatedAt = (await before.json()).data.updatedAt;

  // Sleep > 1ms to dodge same-millisecond inserts.
  await new Promise((r) => setTimeout(r, 5));

  const res = await app.request(`${path}/touch-me/activity`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'Pinged' }),
  });
  expect(res.status).toBe(201);

  const after = await app.request(`${path}/touch-me`, { headers: { Cookie: seed.sessionCookie } });
  const afterUpdatedAt = (await after.json()).data.updatedAt;
  expect(new Date(afterUpdatedAt).getTime()).toBeGreaterThan(new Date(beforeUpdatedAt).getTime());
});

test('POST /:slug/activity 422 on empty note', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'X' }),
  });
  const res = await app.request(`${path}/x/activity`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: '' }),
  });
  expect(res.status).toBe(422);
});

test('POST /:slug/activity 422 when note exceeds the 2000-char cap', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'Big' }),
  });
  const note = 'a'.repeat(2001);
  const res = await app.request(`${path}/big/activity`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note }),
  });
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('NOTE_TOO_LONG');
});

test('POST /:slug/activity 201 when note is exactly at the 2000-char cap', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'Edge' }),
  });
  const note = 'a'.repeat(2000);
  const res = await app.request(`${path}/edge/activity`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note }),
  });
  expect(res.status).toBe(201);
});

test('GET /:slug/events returns a public event shape — no internal columns', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'Sensitive' }),
  });
  await app.request(`${path}/sensitive/activity`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'Internal note' }),
  });

  const res = await app.request(`${path}/sensitive/events`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const events = (await res.json()).data;
  expect(events.length).toBeGreaterThan(0);

  for (const e of events) {
    // Public shape only: id, kind, createdAt, payload, actor (user id is OK).
    expect(Object.keys(e).sort()).toEqual(['actor', 'createdAt', 'id', 'kind', 'payload'].sort());
    // Internal fields must NOT leak.
    expect(e.workspaceId).toBeUndefined();
    expect(e.projectId).toBeUndefined();
    expect(e.documentId).toBeUndefined();
  }
});

test('GET /?stale_for=0d 422 — zero-day window is not a valid filter', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(`${path}?type=work_item&stale_for=0d`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('INVALID_STALE_FOR');
});

test('GET /?stale_for=bogus 422 — non-Nd format is rejected', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(`${path}?type=work_item&stale_for=garbage`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('INVALID_STALE_FOR');
});

test('GET /?stale_for=Nd filters by last_touched_at', async () => {
  const { app, seed } = await makeTestApp();
  // Create 2 work items
  for (const title of ['Fresh', 'Stale']) {
    await app.request(path, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'work_item', title }),
    });
  }
  // Touch only Fresh.
  await app.request(`${path}/fresh/activity`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'Touched' }),
  });
  // Stale-for filter with 7 days — Fresh has lastTouchedAt=now (NOT stale),
  // Stale has lastTouchedAt=null (stale by convention).
  const res = await app.request(`${path}?type=work_item&stale_for=7d`, { headers: { Cookie: seed.sessionCookie } });
  const titles = (await res.json()).data.map((d: { title: string }) => d.title);
  expect(titles).toContain('Stale');
  expect(titles).not.toContain('Fresh');
});
