import { test, expect } from 'bun:test';
import { makeTestApp } from '../test/harness.ts';
import { eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { documents, tables } from '../db/schema.ts';

const path = '/api/v1/w/acme/p/web/documents';

async function createStatus(app: Awaited<ReturnType<typeof makeTestApp>>['app'], cookie: string, key: string) {
  return app.request('/api/v1/w/acme/p/web/statuses', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, name: key }),
  });
}

/**
 * Helper for the workspace-scoped agent endpoint (Phase 2.5).
 * Returns the parsed response body so tests can pluck slug + agent_token.
 */
async function createAgentAtWorkspace(
  app: Awaited<ReturnType<typeof makeTestApp>>['app'],
  cookie: string,
  body: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await app.request('/api/v1/w/acme/documents', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, data: json.data };
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

test('H6: PATCH text/markdown rejects type=comment (must use update_comment)', async () => {
  const { app, seed } = await makeTestApp();
  // Create a parent + comment via the proper REST path.
  const parentRes = await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'Parent' }),
  });
  const parent = (await parentRes.json()).data as { slug: string };
  const commentRes = await app.request(`${path}/${parent.slug}/comments`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'original' }),
  });
  const comment = (await commentRes.json()).data as { slug: string };

  // Markdown PATCH must reject — comment-mutation goes through update_comment.
  const res = await app.request(`${path}/${comment.slug}`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'text/markdown' },
    body: `# tampered\n\nrewritten body\n`,
  });
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('COMMENT_REQUIRES_COMMENT_TOOL');
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

test('project-level GET ?type=agent returns 400 UNSUPPORTED_TYPE_FILTER', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(`${path}?type=agent`, { headers: { Cookie: seed.sessionCookie } });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.code).toBe('UNSUPPORTED_TYPE_FILTER');
  expect(body.error.message).toMatch(/\/w\/acme\/documents/);
});

test('workspace-level GET ?type=agent returns ONLY agents', async () => {
  const { app, seed } = await makeTestApp();
  // Seed noise project docs (these stay project-scoped).
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'noise-W' }),
  });
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'page', title: 'noise-P' }),
  });
  await createAgentAtWorkspace(app, seed.sessionCookie, {
    type: 'agent',
    title: 'A',
    frontmatter: {
      system_prompt: 'x',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      tools: [],
    },
  });
  const res = await app.request('/api/v1/w/acme/documents?type=agent', {
    headers: { Cookie: seed.sessionCookie },
  });
  const body = (await res.json()) as { data: { type: string; title: string }[] };
  expect(body.data).toHaveLength(1);
  expect(body.data[0]!.type).toBe('agent');
  expect(body.data[0]!.title).toBe('A');
});

test('workspace-level GET ?type=trigger returns ONLY triggers', async () => {
  const { app, seed } = await makeTestApp();
  await app.request(path, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'noise-W' }),
  });
  await createAgentAtWorkspace(app, seed.sessionCookie, {
    type: 'trigger',
    title: 'T',
    frontmatter: { agent: 'a', schedule: '0 9 * * *', on_event: null },
  });
  const res = await app.request('/api/v1/w/acme/documents?type=trigger', {
    headers: { Cookie: seed.sessionCookie },
  });
  const body = (await res.json()) as { data: { type: string; title: string }[] };
  expect(body.data).toHaveLength(1);
  expect(body.data[0]!.type).toBe('trigger');
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

test('project-level POST agent returns 422 INVALID_DOCUMENT_SCOPE', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'agent',
      title: 'T',
      frontmatter: { system_prompt: 'x', model: 'x', provider: 'anthropic', tools: [] },
    }),
  });
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('INVALID_DOCUMENT_SCOPE');
  expect(body.error.message).toMatch(/\/w\/acme\/documents/);
});

test('workspace-level POST agent succeeds with project_id NULL', async () => {
  const { app, seed } = await makeTestApp();
  const { status, data } = await createAgentAtWorkspace(app, seed.sessionCookie, {
    type: 'agent',
    title: 'Triage bot',
    frontmatter: {
      system_prompt: 'Help triage incoming bugs.',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      tools: ['list_documents', 'get_document'],
    },
  });
  expect(status).toBe(201);
  expect(data.type).toBe('agent');
  expect(data.projectId ?? null).toBeNull();
  expect(data.workspaceId).toBeTruthy();
  // Default projects: ['*']
  expect((data.frontmatter as { projects: string[] }).projects).toEqual(['*']);
});

test('workspace-level POST trigger succeeds', async () => {
  const { app, seed } = await makeTestApp();
  const { status, data } = await createAgentAtWorkspace(app, seed.sessionCookie, {
    type: 'trigger',
    title: 'Monday standup',
    frontmatter: { agent: 'triage-bot', schedule: '0 9 * * 1', on_event: null },
  });
  expect(status).toBe(201);
  expect(data.type).toBe('trigger');
  expect(data.projectId ?? null).toBeNull();
});

test('POST agent rejects missing required fields', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'agent', title: 'Broken', frontmatter: {} }),
  });
  expect(res.status).toBe(422);
});

test('POST trigger rejects when both schedule and on_event are null', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'trigger',
      title: 'Empty',
      frontmatter: { agent: 'x', schedule: null, on_event: null },
    }),
  });
  expect(res.status).toBe(422);
});

test('POST agent on a table-scoped URL is rejected', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/p/web/t/work-items/documents', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'agent',
      title: 'No table allowed',
      frontmatter: {
        system_prompt: 'x', model: 'x', provider: 'anthropic', tools: [],
      },
    }),
  });
  expect(res.status).toBe(422);
});

test('workspace agent create auto-mints a bearer token', async () => {
  const { app, seed } = await makeTestApp();
  const { status, data } = await createAgentAtWorkspace(app, seed.sessionCookie, {
    type: 'agent', title: 'Bot',
    frontmatter: {
      system_prompt: 'x', model: 'x', provider: 'anthropic',
      tools: ['create_document', 'list_documents'],
    },
  });
  expect(status).toBe(201);
  expect((data.frontmatter as { api_token_id?: string }).api_token_id).toBeTruthy();
  // The plaintext token is returned ONCE alongside the document.
  expect((data as { agent_token?: string }).agent_token).toMatch(/^folio_pat_/);
});

test('workspace agent delete revokes the linked token via cascade FK', async () => {
  const { app, seed } = await makeTestApp();
  const { data } = await createAgentAtWorkspace(app, seed.sessionCookie, {
    type: 'agent', title: 'Bot',
    frontmatter: { system_prompt: 'x', model: 'x', provider: 'anthropic', tools: ['list_documents'] },
  });
  const slug = data.slug as string;
  const agentToken = (data as { agent_token: string }).agent_token;

  // Confirm the token works.
  const tokenWorks = await app.request('/api/v1/w/acme/p/web/documents', {
    headers: { Authorization: `Bearer ${agentToken}` },
  });
  expect(tokenWorks.status).toBe(200);

  // Delete the agent at workspace level.
  const del = await app.request(`/api/v1/w/acme/documents/${slug}`, {
    method: 'DELETE',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(del.status).toBe(204);

  // Token is revoked (cascade FK on api_tokens.agent_id).
  const tokenBlocked = await app.request('/api/v1/w/acme/p/web/documents', {
    headers: { Authorization: `Bearer ${agentToken}` },
  });
  expect(tokenBlocked.status).toBe(401);
});

test('agent.created event emitted on workspace agent create', async () => {
  const { app, seed } = await makeTestApp();
  await createAgentAtWorkspace(app, seed.sessionCookie, {
    type: 'agent', title: 'Bot',
    frontmatter: { system_prompt: 'x', model: 'x', provider: 'anthropic', tools: [] },
  });
  const { db } = await import('../db/client.ts');
  const { events } = await import('../db/schema.ts');
  const { eq } = await import('drizzle-orm');
  const rows = await db.query.events.findMany({ where: eq(events.kind, 'agent.created') });
  expect(rows.length).toBeGreaterThan(0);
  // Phase 2.5: workspace-scoped emission has projectId NULL.
  expect(rows[0]!.projectId).toBeNull();
});

test('work item POST with assignee=agent:slug emits agent.task.assigned', async () => {
  const { app, seed } = await makeTestApp();
  // First create the agent so the slug exists.
  await createAgentAtWorkspace(app, seed.sessionCookie, {
    type: 'agent', title: 'Bot',
    frontmatter: { system_prompt: 'x', model: 'x', provider: 'anthropic', tools: ['list_documents'] },
  });

  await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'work_item', title: 'Triage me',
      frontmatter: { assignee: 'agent:bot' },
    }),
  });

  const { db } = await import('../db/client.ts');
  const { events } = await import('../db/schema.ts');
  const { eq } = await import('drizzle-orm');
  const rows = await db.query.events.findMany({ where: eq(events.kind, 'agent.task.assigned') });
  expect(rows.length).toBe(1);
});

test('work item PATCH that adds assignee=agent:slug emits agent.task.assigned', async () => {
  const { app, seed } = await makeTestApp();
  await createAgentAtWorkspace(app, seed.sessionCookie, {
    type: 'agent', title: 'Bot',
    frontmatter: { system_prompt: 'x', model: 'x', provider: 'anthropic', tools: [] },
  });
  const create = await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'No assignee yet' }),
  });
  const { data: { slug } } = await create.json();

  await app.request(`/api/v1/w/acme/p/web/documents/${slug}`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ frontmatter: { assignee: 'agent:bot' } }),
  });

  const { db } = await import('../db/client.ts');
  const { events } = await import('../db/schema.ts');
  const { eq } = await import('drizzle-orm');
  const rows = await db.query.events.findMany({ where: eq(events.kind, 'agent.task.assigned') });
  expect(rows.length).toBe(1);
});

test('PATCH that keeps the same agent assignee does NOT re-emit', async () => {
  const { app, seed } = await makeTestApp();
  await createAgentAtWorkspace(app, seed.sessionCookie, {
    type: 'agent', title: 'Bot',
    frontmatter: { system_prompt: 'x', model: 'x', provider: 'anthropic', tools: [] },
  });
  const create = await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'work_item', title: 'Triage',
      frontmatter: { assignee: 'agent:bot' },
    }),
  });
  const { data: { slug } } = await create.json();

  // PATCH that doesn't change the assignee — emits nothing.
  await app.request(`/api/v1/w/acme/p/web/documents/${slug}`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ frontmatter: { assignee: 'agent:bot', priority: 'high' } }),
  });

  const { db } = await import('../db/client.ts');
  const { events } = await import('../db/schema.ts');
  const { eq } = await import('drizzle-orm');
  const rows = await db.query.events.findMany({ where: eq(events.kind, 'agent.task.assigned') });
  expect(rows.length).toBe(1);  // still just the create
});

test('an agent token cannot delegate past its max_delegation_depth', async () => {
  const { app, seed } = await makeTestApp();
  // Workspace-scoped agent with max_delegation_depth: 0 (cannot delegate at all).
  const { data } = await createAgentAtWorkspace(app, seed.sessionCookie, {
    type: 'agent', title: 'Bot',
    frontmatter: {
      system_prompt: 'x', model: 'x', provider: 'anthropic',
      tools: ['create_document'], max_delegation_depth: 0,
    },
  });
  const agentToken = (data as { agent_token: string }).agent_token;

  // Bearer-auth'd POST creating a work item assigned to itself — depth 1 > max 0.
  const childCreate = await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'work_item', title: 'I am trying to assign',
      frontmatter: { assignee: 'agent:bot' },
    }),
  });
  expect(childCreate.status).toBe(403);
  const body = await childCreate.json();
  expect(body.error.code).toBe('DELEGATION_DEPTH_EXCEEDED');
});

// --- Phase 2.5 BUG-001 regression: requireResource is wired on project routes ---

test('agent bearer narrowed to other projects is denied at project scope (FORBIDDEN_RESOURCE)', async () => {
  const { app, seed } = await makeTestApp();

  // Create a second project via the API so defaults (work-items table, statuses,
  // views) get seeded — needed because GET ?type=work_item resolves the table.
  const createProj = await app.request('/api/v1/w/acme/projects', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Other', slug: 'other' }),
  });
  expect(createProj.status).toBe(201);
  const otherProjectId = (await createProj.json()).data.id as string;

  // Mint an agent narrowed to `other` only — the default seeded project `web`
  // is explicitly NOT in the allow-list. Use the read-only `list_documents`
  // tool so we exercise the GET path.
  const { data: agent } = await createAgentAtWorkspace(app, seed.sessionCookie, {
    type: 'agent', title: 'Other Only',
    frontmatter: {
      system_prompt: 'x', model: 'm', provider: 'anthropic',
      tools: ['list_documents'],
      projects: [otherProjectId],
    },
  });
  const agentToken = (agent as { agent_token: string }).agent_token;

  // Allowed: hitting the `other` project (in allow-list) → 200.
  const okRes = await app.request('/api/v1/w/acme/p/other/documents?type=work_item', {
    headers: { Authorization: `Bearer ${agentToken}` },
  });
  expect(okRes.status).toBe(200);

  // Denied: hitting `web` (NOT in allow-list) → 403 FORBIDDEN_RESOURCE.
  const denyRes = await app.request('/api/v1/w/acme/p/web/documents?type=work_item', {
    headers: { Authorization: `Bearer ${agentToken}` },
  });
  expect(denyRes.status).toBe(403);
  const body = await denyRes.json();
  expect(body.error.code).toBe('FORBIDDEN_RESOURCE');
  expect(body.error.message).toMatch(/agent not allow-listed for project web/);

  // Wildcard agent must continue to pass on any project — sanity check that
  // the gate doesn't fire when intersect() returns ['*'].
  const { data: wildAgent } = await createAgentAtWorkspace(app, seed.sessionCookie, {
    type: 'agent', title: 'Wild',
    frontmatter: {
      system_prompt: 'x', model: 'm', provider: 'anthropic',
      tools: ['list_documents'],
      // projects defaults to ['*']
    },
  });
  const wildToken = (wildAgent as { agent_token: string }).agent_token;
  const wildRes = await app.request('/api/v1/w/acme/p/web/documents?type=work_item', {
    headers: { Authorization: `Bearer ${wildToken}` },
  });
  expect(wildRes.status).toBe(200);
});

// ---------- F3 + F9 + F10 regression — cross-route agent_run guards ----------
//
// agent_run rows are runner-owned. The state machine + closed
// error_reason enum + sanitizer + agent.run.* event emission all live
// in services/agent-runs.ts. The generic document routes must reject
// agent_run defensively (PATCH / DELETE / POST / createDocument) so a
// hostile or buggy MCP client (cast-to-string at the boundary) can't
// drive a row mutation that bypasses C.1's mitigations.

async function seedAgentRunRow(
  db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  seed: Awaited<ReturnType<typeof makeTestApp>>['seed'],
): Promise<{ runSlug: string }> {
  const tableId = nanoid();
  await db.insert(tables).values({
    id: tableId,
    projectId: seed.project.id,
    slug: 'runs-fixture',
    name: 'Runs (test fixture)',
    icon: null,
    order: 100,
  });
  const parentId = nanoid();
  await db.insert(documents).values({
    id: parentId,
    workspaceId: seed.workspace.id,
    projectId: seed.project.id,
    tableId: null,
    type: 'work_item',
    slug: `wi-parent-${nanoid(6)}`,
    title: 'Parent',
    status: null,
    body: '',
    frontmatter: {},
    createdBy: seed.user.id,
    updatedBy: seed.user.id,
  });
  const runId = nanoid();
  const runSlug = `helper-run-${nanoid(6)}`;
  await db.insert(documents).values({
    id: runId,
    workspaceId: seed.workspace.id,
    projectId: seed.project.id,
    tableId,
    type: 'agent_run',
    slug: runSlug,
    title: 'fixture run',
    status: 'planning',
    body: '',
    frontmatter: {
      assignee: 'agent:helper',
      status: 'planning',
      agent_slug: 'helper',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      system_prompt: 'x',
      max_tokens: 1000,
      tokens_in: 0,
      tokens_out: 0,
      trigger_id: null,
      chain_id: crypto.randomUUID(),
      fired_by: 'manual',
      started_at: new Date().toISOString(),
    },
    parentId,
    createdBy: seed.user.id,
    updatedBy: seed.user.id,
  });
  return { runSlug };
}

test('F3: PATCH markdown on an agent_run row returns 422 AGENT_RUN_REQUIRES_RUNNER_PATH', async () => {
  const { app, db, seed } = await makeTestApp();
  const { runSlug } = await seedAgentRunRow(db, seed);

  const md = `---
title: hacked
status: completed
tokens_in: 999999
---

body
`;
  const res = await app.request(`/api/v1/w/acme/p/web/documents/${runSlug}`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'text/markdown' },
    body: md,
  });
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('AGENT_RUN_REQUIRES_RUNNER_PATH');

  // Row is unchanged — verifying the guard didn't silently let the PATCH
  // through.
  const row = await db.query.documents.findFirst({
    where: eq(documents.slug, runSlug),
  });
  expect(row!.status).toBe('planning');
  expect((row!.frontmatter as Record<string, unknown>).tokens_in).toBe(0);
});

test('F3: PATCH JSON on an agent_run row returns 422 AGENT_RUN_REQUIRES_RUNNER_PATH', async () => {
  const { app, db, seed } = await makeTestApp();
  const { runSlug } = await seedAgentRunRow(db, seed);

  const res = await app.request(`/api/v1/w/acme/p/web/documents/${runSlug}`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ frontmatter: { status: 'completed' } }),
  });
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('AGENT_RUN_REQUIRES_RUNNER_PATH');
});

test('F3: DELETE on an agent_run row returns 422 AGENT_RUN_REQUIRES_RUNNER_PATH', async () => {
  const { app, db, seed } = await makeTestApp();
  const { runSlug } = await seedAgentRunRow(db, seed);

  const res = await app.request(`/api/v1/w/acme/p/web/documents/${runSlug}`, {
    method: 'DELETE',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('AGENT_RUN_REQUIRES_RUNNER_PATH');

  // Row still exists.
  const row = await db.query.documents.findFirst({
    where: eq(documents.slug, runSlug),
  });
  expect(row).toBeTruthy();
});

test('F9 + F10: POST markdown with type: agent_run returns 422 (not silently coerced to work_item)', async () => {
  // Pre-F10, parseMarkdownInput's DOCUMENT_TYPES didn't include agent_run
  // so the type was silently coerced to 'work_item' (the default).
  // Post-F10, the type is recognized; post-F9, createDocument rejects it
  // with a clean 422 instead of an opaque CHECK-constraint 500.
  const { app, seed } = await makeTestApp();
  const md = `---
type: agent_run
title: spoofed
assignee: agent:malicious
tokens_in: 999999
---

body
`;
  const res = await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'text/markdown' },
    body: md,
  });
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('AGENT_RUN_REQUIRES_RUNNER_PATH');
});

test('F9: POST JSON with type: agent_run returns 422 (defense-in-depth)', async () => {
  // documentCreateSchema may reject this at the route layer before
  // reaching createDocument — verify the response is a clean 422 with a
  // type-related error (either AGENT_RUN_REQUIRES_RUNNER_PATH if it
  // passes the schema, or INVALID_BODY if the schema rejects it
  // upstream — both are acceptable as long as it isn't 500).
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'agent_run',
      title: 'spoofed',
      frontmatter: {},
    }),
  });
  expect(res.status).toBe(422);
  const body = await res.json();
  // Either the route-level Zod schema or the service-level guard catches
  // this. Both signal the same intent: agent_run is not creatable via
  // the generic documents endpoint.
  expect(
    body.error.code === 'AGENT_RUN_REQUIRES_RUNNER_PATH' ||
    body.error.code === 'INVALID_BODY',
  ).toBe(true);
});

// ---------- R2 regression — agent_run READ paths guarded ----------
//
// Bundle 4 hardened WRITE paths (PATCH md/JSON, DELETE, POST). The
// review-of-review surfaced that READ paths (GET /:slug, GET /:slug.md,
// MCP get_document, MCP get_document_markdown, MCP list_documents) were
// still open. A `documents:read` bearer could enumerate run slugs via
// list_documents?type=agent_run and dump each row's frontmatter.system_prompt
// via get_document. These tests pin the closed surface.

test('R2: GET /:slug.md on an agent_run row returns 422 AGENT_RUN_REQUIRES_RUNNER_PATH', async () => {
  const { app, db, seed } = await makeTestApp();
  const { runSlug } = await seedAgentRunRow(db, seed);

  const res = await app.request(`/api/v1/w/acme/p/web/documents/${runSlug}.md`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('AGENT_RUN_REQUIRES_RUNNER_PATH');
});

test('R2: GET /:slug (JSON) on an agent_run row returns 422 AGENT_RUN_REQUIRES_RUNNER_PATH', async () => {
  const { app, db, seed } = await makeTestApp();
  const { runSlug } = await seedAgentRunRow(db, seed);

  const res = await app.request(`/api/v1/w/acme/p/web/documents/${runSlug}`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('AGENT_RUN_REQUIRES_RUNNER_PATH');
});

test('R2: default GET /documents (no type filter) does NOT leak agent_run rows', async () => {
  const { app, db, seed } = await makeTestApp();
  const { runSlug } = await seedAgentRunRow(db, seed);

  // Also seed a regular work_item so the response isn't empty.
  await db.insert(documents).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    projectId: seed.project.id,
    tableId: null,
    type: 'work_item',
    slug: `wi-visible-${nanoid(6)}`,
    title: 'Visible',
    status: null,
    body: '',
    frontmatter: {},
    createdBy: seed.user.id,
    updatedBy: seed.user.id,
  });

  const res = await app.request('/api/v1/w/acme/p/web/documents', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  const slugs = (body.data as Array<{ slug: string; type: string }>).map((d) => d.slug);
  expect(slugs).not.toContain(runSlug);
  // The work_item IS returned.
  expect(slugs.some((s) => s.startsWith('wi-visible-'))).toBe(true);
});

test('C1: explicit ?type=agent_run is REJECTED (422) and never lists system_prompt', async () => {
  // Phase-3 shake-out C1 (security): the agent_run wall is enforced on the
  // single GET / markdown / create / update / delete paths AND the MCP read
  // tools — but the generic-document LIST path previously treated `agent_run`
  // as a queryable type, returning full rows (incl. frontmatter.system_prompt)
  // to any documents:read bearer or in-project agent. That is the slug-
  // enumeration → system_prompt-dump vector the R2 mitigation claimed to close.
  // Fixed in two layers: the route early-rejects explicit type=agent_run with a
  // clean 422, and listDocuments rejects it at the source (defense in depth).
  // Runs are read via GET /api/v1/w/:wslug/p/:pslug/runs, never enumerated here.
  const { app, db, seed } = await makeTestApp();
  await seedAgentRunRow(db, seed);

  const res = await app.request('/api/v1/w/acme/p/web/documents?type=agent_run', {
    headers: { Cookie: seed.sessionCookie },
  });
  // Hard requirement: rejected, not listed.
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('AGENT_RUN_REQUIRES_RUNNER_PATH');
  // And the operator-sensitive prompt must not appear anywhere in the response.
  expect(JSON.stringify(body)).not.toContain('system_prompt');
});
