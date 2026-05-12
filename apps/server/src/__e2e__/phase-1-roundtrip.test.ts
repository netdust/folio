import { test, expect } from 'bun:test';
import { eq } from 'drizzle-orm';
import { makeTestApp } from '../test/harness.ts';
import { events } from '../db/schema.ts';

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
