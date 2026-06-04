import { test, expect } from 'bun:test';
import { makeTestApp } from '../test/harness.ts';
import { createSession, newApiToken } from '../lib/auth.ts';

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

test('CR-2/3: DELETE project — an instance-member with a workspace_access grant CAN delete (204)', async () => {
  // Pre-fix the handler gated `getRole(c)==='owner'`, so any non-instance-owner
  // (incl. the workspace creator, now an instance-member holding a ws grant) was
  // 403'd. The decision: project-delete authority = canSeeProject (owner ||
  // ws-grant || project-grant). Demote the harness owner to a plain member; it
  // KEEPS its harness workspace_access grant → canSeeProject true → succeeds.
  const { app, db, seed } = await makeTestApp();
  const { users } = await import('../db/schema.ts');
  const { eq } = await import('drizzle-orm');
  await db.update(users).set({ role: 'member' }).where(eq(users.id, seed.user.id));

  const res = await app.request(`/api/v1/w/acme/p/${seed.project.slug}`, {
    method: 'DELETE',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(204);
});

test('CR-2/3: DELETE project — an instance-member with ONLY a project_access grant CAN delete (204)', async () => {
  // A project-grant holder (no ws grant) reaches the project via canSeeProject's
  // direct-project clause; under the decision (delete == canSeeProject) they may
  // delete it. Set up a fresh member who holds only project_access on p1.
  const { app, db, seed } = await makeTestApp();
  const { users, projectAccess } = await import('../db/schema.ts');
  const memberId = nanoid();
  await db.insert(users).values({
    id: memberId,
    email: 'pgrant@test.local',
    name: 'PGrant',
    passwordHash: 'x',
    role: 'member',
  });
  await db.insert(projectAccess).values({ userId: memberId, projectId: seed.project.id });
  const session = await createSession(memberId);

  const res = await app.request(`/api/v1/w/acme/p/${seed.project.slug}`, {
    method: 'DELETE',
    headers: { Cookie: `folio_session=${session.id}` },
  });
  expect(res.status).toBe(204);
});

test('CR-2/3: DELETE project — a non-grantee (stranger member) cannot delete (403/404, no scrub)', async () => {
  // A member with NO grant of any kind is blocked at resolveProject (visibility),
  // which is the correct "cannot manage" outcome — the cascade never runs.
  const { app, db, seed } = await makeTestApp();
  const { users } = await import('../db/schema.ts');
  const strangerId = nanoid();
  await db.insert(users).values({
    id: strangerId,
    email: 'nogrant@test.local',
    name: 'NoGrant',
    passwordHash: 'x',
    role: 'member',
  });
  const session = await createSession(strangerId);

  const agent = await createAgentWithProjects(app, seed.sessionCookie, 'Specific', [seed.project.id]);

  const res = await app.request(`/api/v1/w/acme/p/${seed.project.slug}`, {
    method: 'DELETE',
    headers: { Cookie: `folio_session=${session.id}` },
  });
  expect(res.status).not.toBe(204);
  expect([403, 404]).toContain(res.status);

  // The agent's frontmatter is untouched because the cascade never ran.
  const { documents } = await import('../db/schema.ts');
  const { eq } = await import('drizzle-orm');
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

test('CR-5: an instance-reach token minted by a grant-less member sees ALL projects in a workspace', async () => {
  // GET /w/W/projects with an instance-reach token (workspaceId=null) whose
  // CREATOR is an instance-member with NO grant in W. The token is
  // owner-equivalent (resolveWorkspace sets role='owner'), so listProjects must
  // return ALL projects in W — NOT [] (which the pre-fix re-derivation from the
  // grant-less creator produced).
  const { app, db, seed } = await makeTestApp();
  const { apiTokens, users, projects: projectsTbl } = await import('../db/schema.ts');

  // A second project in W (the harness seeds one: 'web').
  await db.insert(projectsTbl).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    slug: 'mobile',
    name: 'Mobile',
  });

  // The token creator: an instance-member with NO grant anywhere.
  const creatorId = nanoid();
  await db.insert(users).values({
    id: creatorId,
    email: 'instance-creator@test.local',
    name: 'InstanceCreator',
    passwordHash: 'x',
    role: 'member',
  });

  // Instance-reach token: workspaceId null, human createdBy (hydrates creator).
  const tok = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: null,
    name: 'instance-read',
    tokenHash: tok.hash,
    scopes: ['documents:read'],
    createdBy: creatorId,
  });

  const res = await app.request('/api/v1/w/acme/projects', {
    headers: { Authorization: `Bearer ${tok.token}` },
  });
  expect(res.status).toBe(200);
  const slugs = ((await res.json()).data as { slug: string }[]).map((p) => p.slug).sort();
  expect(slugs).toEqual(['mobile', 'web']);
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
