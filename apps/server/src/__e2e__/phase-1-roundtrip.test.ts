import { test, expect } from 'bun:test';
import { eq } from 'drizzle-orm';
import { makeTestApp } from '../test/harness.ts';
import { events, magicLinks } from '../db/schema.ts';
import { hashToken } from '../lib/auth.ts';

test('Phase 1 happy path: workspace → project → MD document → patch → :slug.md round-trip', async () => {
  const { app, db, seed } = await makeTestApp();
  const H = { Cookie: seed.sessionCookie };

  // 1. The harness already creates workspace "acme" + project "web".
  //    Create a fresh project via POST so default seeding runs.
  const proj = await app.request('/api/v1/w/acme/projects', {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Phase One', slug: 'p1' }),
  });
  expect(proj.status).toBe(201);

  // Verify 4 default statuses + 2 default views were seeded.
  const projData = (await proj.json()).data;
  const { statuses, views } = await import('../db/schema.ts');
  const seededStatuses = await db.select().from(statuses).where(eq(statuses.projectId, projData.id));
  const seededViews = await db.select().from(views).where(eq(views.projectId, projData.id));
  expect(seededStatuses).toHaveLength(4);
  expect(seededViews).toHaveLength(2);

  // 2. POST text/markdown document with frontmatter
  const md = `---
type: work_item
status: in_progress
priority: high
---

# Phase One Document

Body content.
`;
  const create = await app.request('/api/v1/w/acme/p/p1/documents', {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'text/markdown' },
    body: md,
  });
  expect(create.status).toBe(201);
  const doc = (await create.json()).data;
  expect(doc.status).toBe('in_progress');
  expect(doc.title).toBe('Phase One Document');

  // 3. PATCH JSON to change frontmatter.priority — preserves other keys
  const patch = await app.request(`/api/v1/w/acme/p/p1/documents/${doc.slug}`, {
    method: 'PATCH',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ frontmatter: { priority: 'urgent' } }),
  });
  expect(patch.status).toBe(200);
  expect((await patch.json()).data.frontmatter.priority).toBe('urgent');

  // 4. GET :slug.md and assert round-trip
  const rt = await app.request(`/api/v1/w/acme/p/p1/documents/${doc.slug}.md`, { headers: H });
  expect(rt.status).toBe(200);
  const text = await rt.text();
  expect(text).toMatch(/priority: urgent/);
  expect(text).toMatch(/status: in_progress/);
  expect(text).toMatch(/^# Phase One Document/m);

  // 5. Events table populated
  const all = await db.select().from(events);
  const kinds = all.map((r) => r.kind);
  expect(kinds).toContain('project.created');
  expect(kinds).toContain('document.created');
  expect(kinds).toContain('document.updated');
});

test('Phase 1 normalization: workspace shapes match what the client consumes', async () => {
  const { app, seed } = await makeTestApp();
  const H = { Cookie: seed.sessionCookie };

  // GET /api/v1/workspaces — kept-wrapped membership shape [{ workspace, role }]
  const list = await app.request('/api/v1/workspaces', { headers: H });
  expect(list.status).toBe(200);
  const listBody = await list.json();
  expect(Array.isArray(listBody.data)).toBe(true);
  expect(listBody.data).toHaveLength(1);
  const [membership] = listBody.data;
  expect(membership.workspace.slug).toBe('acme');
  expect(membership.workspace.name).toBe('Acme');
  expect(membership.workspace.id).toBeDefined();
  expect(membership.workspace.createdAt).toBeDefined();
  expect(membership.workspace.updatedAt).toBeDefined();
  expect(membership.role).toBe('owner');
  // No AI fields leaked into the workspace row
  expect(membership.workspace).not.toHaveProperty('aiProvider');
  expect(membership.workspace).not.toHaveProperty('aiModel');
  expect(membership.workspace).not.toHaveProperty('keyConfigured');

  // GET /api/v1/w/:wslug — flattened detail (Workspace & { role })
  const detail = await app.request('/api/v1/w/acme', { headers: H });
  expect(detail.status).toBe(200);
  const detailBody = await detail.json();
  // Bare row, no { workspace: ... } wrap
  expect(detailBody.data.slug).toBe('acme');
  expect(detailBody.data.name).toBe('Acme');
  expect(detailBody.data.role).toBe('owner');
  expect(detailBody.data).not.toHaveProperty('workspace');

  // POST /api/v1/workspaces — returns bare { id, slug, name }
  const created = await app.request('/api/v1/workspaces', {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Beta Co' }),
  });
  expect(created.status).toBe(201);
  const createdBody = await created.json();
  expect(createdBody.data.slug).toBe('beta-co');
  expect(createdBody.data.name).toBe('Beta Co');
  expect(createdBody.data.id).toBeDefined();
  expect(createdBody.data).not.toHaveProperty('workspace');

  // PATCH /api/v1/w/:wslug — returns bare row with bumped updatedAt
  const beforeMs = Date.now();
  // Wait 1ms so the timestamp can actually advance on systems with ms granularity
  await new Promise((r) => setTimeout(r, 2));
  const patched = await app.request('/api/v1/w/acme', {
    method: 'PATCH',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Acme Renamed' }),
  });
  expect(patched.status).toBe(200);
  const patchedBody = await patched.json();
  expect(patchedBody.data.name).toBe('Acme Renamed');
  expect(patchedBody.data).not.toHaveProperty('workspace');
  expect(new Date(patchedBody.data.updatedAt).getTime()).toBeGreaterThanOrEqual(beforeMs);
});

test('Phase 1 normalization: project shapes match what the client consumes', async () => {
  const { app, seed } = await makeTestApp();
  const H = { Cookie: seed.sessionCookie };

  // POST /api/v1/w/:wslug/projects — bare row, no { project: ... } wrap
  const created = await app.request('/api/v1/w/acme/projects', {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Mobile' }),
  });
  expect(created.status).toBe(201);
  const createdBody = await created.json();
  expect(createdBody.data.slug).toBe('mobile');
  expect(createdBody.data.name).toBe('Mobile');
  expect(createdBody.data.workspaceId).toBeDefined();
  expect(createdBody.data).not.toHaveProperty('project');

  // GET /api/v1/w/:wslug/p/:pslug — bare row
  const detail = await app.request('/api/v1/w/acme/p/web', { headers: H });
  expect(detail.status).toBe(200);
  const detailBody = await detail.json();
  expect(detailBody.data.slug).toBe('web');
  expect(detailBody.data.name).toBe('Web');
  expect(detailBody.data).not.toHaveProperty('project');

  // PATCH /api/v1/w/:wslug/p/:pslug — bare row with bumped updatedAt
  const beforeMs = Date.now();
  await new Promise((r) => setTimeout(r, 2));
  const patched = await app.request('/api/v1/w/acme/p/web', {
    method: 'PATCH',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Web Renamed' }),
  });
  expect(patched.status).toBe(200);
  const patchedBody = await patched.json();
  expect(patchedBody.data.name).toBe('Web Renamed');
  expect(patchedBody.data).not.toHaveProperty('project');
  expect(new Date(patchedBody.data.updatedAt).getTime()).toBeGreaterThanOrEqual(beforeMs);

  // GET collection still a bare array
  const list = await app.request('/api/v1/w/acme/projects', { headers: H });
  expect(list.status).toBe(200);
  const listBody = await list.json();
  expect(Array.isArray(listBody.data)).toBe(true);
  expect(listBody.data.length).toBeGreaterThanOrEqual(1);
});

test('Phase 1 normalization: magic-link routes live at the canonical paths', async () => {
  const { app, db } = await makeTestApp();

  // Old path is gone
  const stale = await app.request('/api/v1/auth/magic/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'new@test.local' }),
  });
  expect(stale.status).toBe(404);

  // New /magic-link/request issues a magic link
  const req = await app.request('/api/v1/auth/magic-link/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'new@test.local' }),
  });
  expect(req.status).toBe(200);
  expect((await req.json()).data.ok).toBe(true);

  // The request actually persisted a magic-link row.
  const rows = await db.select().from(magicLinks).where(eq(magicLinks.email, 'new@test.local'));
  expect(rows).toHaveLength(1);

  // /magic-link/consume accepts the token (handler issues a 302 to /)
  // Note: we can't read the raw token (only its hash is stored), so we
  // only assert the route exists with the correct verb and that the
  // OLD /magic/verify path returns 404.
  const staleVerify = await app.request('/api/v1/auth/magic/verify?token=anything');
  expect(staleVerify.status).toBe(404);

  // New path: invalid token should yield 400 (route IS mounted, but token doesn't match).
  const badConsume = await app.request('/api/v1/auth/magic-link/consume?token=not-a-real-token');
  expect(badConsume.status).toBe(400);
});
