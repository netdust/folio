import { test, expect } from 'bun:test';
import { makeTestApp } from '../test/harness.ts';
import { newApiToken } from '../lib/auth.ts';

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
  expect((await res.json()).data.slug).toBe('mobile');
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
  expect((await res.json()).data.slug).toBe('web-2');
});

test('GET /w/:wslug/projects/:pslug returns the project', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/p/web', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  expect((await res.json()).data.slug).toBe('web');
});

test('PATCH /w/:wslug/projects/:pslug renames', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/p/web', {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Webapp' }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).data.name).toBe('Webapp');
});

test('DELETE /w/:wslug/projects/:pslug (owner) returns 204', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/p/web', {
    method: 'DELETE',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(204);
});

test('GET unknown project → 404 PROJECT_NOT_FOUND', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/p/nope', {
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
  const { data: project } = await create.json();
  const s = await db.select().from(statuses).where(eq(statuses.projectId, project.id));
  const v = await db.select().from(views).where(eq(views.projectId, project.id));
  expect(s).toHaveLength(4);
  expect(v).toHaveLength(2);
});

// --- Phase 2.5: project-delete cascade for workspace agent allow-lists ---

import { nanoid } from 'nanoid';

async function createAgentWithProjects(
  app: Awaited<ReturnType<typeof makeTestApp>>['app'],
  cookie: string,
  title: string,
  projects: string[],
) {
  const res = await app.request('/api/v1/w/acme/documents', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'agent',
      title,
      frontmatter: {
        system_prompt: 'x',
        model: 'm',
        provider: 'anthropic',
        tools: [],
        projects,
      },
    }),
  });
  return (await res.json()).data;
}

test('DELETE project scrubs its id from workspace agent.frontmatter.projects', async () => {
  const { app, db, seed } = await makeTestApp();
  const { projects: projectsTbl, documents } = await import('../db/schema.ts');
  const { eq } = await import('drizzle-orm');

  // Add a second project so we can prove the cascade scrubs A and leaves B.
  const projectBId = nanoid();
  await db.insert(projectsTbl).values({
    id: projectBId,
    workspaceId: seed.workspace.id,
    slug: 'inbox',
    name: 'Inbox',
  });

  // Agent allow-listed for A + B; another allow-listed wildcard.
  const a1 = await createAgentWithProjects(app, seed.sessionCookie, 'Specific', [
    seed.project.id,
    projectBId,
  ]);
  const a2 = await createAgentWithProjects(app, seed.sessionCookie, 'Wildcard', ['*']);

  // Delete project A.
  const del = await app.request(`/api/v1/w/acme/p/${seed.project.slug}`, {
    method: 'DELETE',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(del.status).toBe(204);

  // Specific: A is gone, B remains.
  const a1Row = await db.query.documents.findFirst({ where: eq(documents.id, a1.id) });
  expect((a1Row!.frontmatter as { projects: string[] }).projects).toEqual([projectBId]);

  // Wildcard: unchanged.
  const a2Row = await db.query.documents.findFirst({ where: eq(documents.id, a2.id) });
  expect((a2Row!.frontmatter as { projects: string[] }).projects).toEqual(['*']);
});

test('DELETE project — non-owner returns 403 without scrubbing', async () => {
  const { app, db, seed } = await makeTestApp();
  // Demote seed user to member (so we have a non-owner trying to delete).
  const { memberships } = await import('../db/schema.ts');
  const { eq, and } = await import('drizzle-orm');
  await db
    .update(memberships)
    .set({ role: 'member' })
    .where(and(eq(memberships.workspaceId, seed.workspace.id), eq(memberships.userId, seed.user.id)));

  const agent = await createAgentWithProjects(app, seed.sessionCookie, 'Specific', [seed.project.id]);

  const res = await app.request(`/api/v1/w/acme/p/${seed.project.slug}`, {
    method: 'DELETE',
    headers: { Cookie: seed.sessionCookie },
  });
  // Member-tier permission rejection — actual code is whatever scope.ts emits;
  // common Folio convention is 403 FORBIDDEN.
  expect(res.status).toBe(403);

  // The agent's frontmatter is untouched because the transaction never ran.
  const { documents } = await import('../db/schema.ts');
  const row = await db.query.documents.findFirst({ where: eq(documents.id, agent.id) });
  expect((row!.frontmatter as { projects: string[] }).projects).toEqual([seed.project.id]);
});

// --- Phase 2 (operator): config:write guard + dryRun on project routes (P2-2/4/5/6/8) ---

async function mintProjectTokens(
  db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  seed: Awaited<ReturnType<typeof makeTestApp>>['seed'],
) {
  const { apiTokens } = await import('../db/schema.ts');
  const cw = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    name: 'config-write',
    tokenHash: cw.hash,
    scopes: ['config:write', 'documents:read'],
    createdBy: seed.user.id,
  });
  const dw = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    name: 'docs-write',
    tokenHash: dw.hash,
    scopes: ['documents:write', 'documents:read'],
    createdBy: seed.user.id,
  });
  return { configWriteToken: cw.token, docsWriteToken: dw.token };
}

async function projectCount(
  db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  wsId: string,
): Promise<number> {
  const { projects } = await import('../db/schema.ts');
  const { eq } = await import('drizzle-orm');
  return (await db.select().from(projects).where(eq(projects.workspaceId, wsId))).length;
}

test('POST /projects: config:write token creates a project (201)', async () => {
  const { app, db, seed } = await makeTestApp();
  const { configWriteToken } = await mintProjectTokens(db, seed);
  const res = await app.request('/api/v1/w/acme/projects', {
    method: 'POST',
    headers: { Authorization: `Bearer ${configWriteToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Mobile' }),
  });
  expect(res.status).toBe(201);
  expect((await res.json()).data.slug).toBe('mobile');
});

test('POST /projects: documents:write token cannot create a project (403)', async () => {
  const { app, db, seed } = await makeTestApp();
  const { docsWriteToken } = await mintProjectTokens(db, seed);
  const res = await app.request('/api/v1/w/acme/projects', {
    method: 'POST',
    headers: { Authorization: `Bearer ${docsWriteToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Mobile' }),
  });
  expect(res.status).toBe(403);
});

test('POST /projects: dryRun create does not mutate', async () => {
  const { app, db, seed } = await makeTestApp();
  const { configWriteToken } = await mintProjectTokens(db, seed);
  const before = await projectCount(db, seed.workspace.id);
  const res = await app.request('/api/v1/w/acme/projects', {
    method: 'POST',
    headers: { Authorization: `Bearer ${configWriteToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Preview', dryRun: true }),
  });
  expect(res.status).toBe(200);
  const data = (await res.json()).data;
  expect(data.dry_run).toBe(true);
  expect(data.would).toBe('create');
  expect(data.resource.name).toBe('Preview');
  expect(await projectCount(db, seed.workspace.id)).toBe(before);
});

test('P2-5 regression: a token cannot create a workspace', async () => {
  const { app, db, seed } = await makeTestApp();
  const { configWriteToken } = await mintProjectTokens(db, seed);
  const res = await app.request('/api/v1/workspaces', {
    method: 'POST',
    headers: { Authorization: `Bearer ${configWriteToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Hax' }),
  });
  expect([401, 403]).toContain(res.status);
});
