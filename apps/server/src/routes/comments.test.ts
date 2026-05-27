import { expect, test } from 'bun:test';
import { makeTestApp } from '../test/harness.ts';

// Path helpers — all comments routes live under the project scope.
const parentPath = (slug: string) => `/api/v1/w/acme/p/web/documents/${slug}/comments`;
const itemPath = (slug: string) => `/api/v1/w/acme/p/web/comments/${slug}`;

const docsPath = '/api/v1/w/acme/p/web/documents';

type AppShape = Awaited<ReturnType<typeof makeTestApp>>['app'];

/** Create a project-scoped work_item via the existing route and return its slug. */
async function createParent(
  app: AppShape,
  cookie: string,
  title = 'Parent',
  type: 'work_item' | 'page' = 'work_item',
): Promise<string> {
  const res = await app.request(docsPath, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, title }),
  });
  const j = await res.json();
  return j.data.slug as string;
}

/** Workspace-scoped agent create — used to mint a bearer token + agent doc. */
async function createAgentAtWorkspace(
  app: AppShape,
  cookie: string,
  body: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await app.request('/api/v1/w/acme/documents', {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()).data };
}

/** Second-user helper for non-author tests. */
async function makeSecondUser(app: AppShape, workspaceId: string): Promise<string> {
  const { nanoid } = await import('nanoid');
  const { db } = await import('../db/client.ts');
  const { users, memberships } = await import('../db/schema.ts');
  const { createSession, hashPassword } = await import('../lib/auth.ts');
  const userId = nanoid();
  const passwordHash = await hashPassword('password123');
  await db.insert(users).values({
    id: userId,
    email: `${userId}@test.local`,
    name: 'Bob',
    passwordHash,
  });
  await db.insert(memberships).values({ workspaceId, userId, role: 'member' });
  const session = await createSession(userId);
  return `folio_session=${session.id}`;
}

// -----------------------------------------------------------------------------
// 1. POST happy path — session user
// -----------------------------------------------------------------------------

test('POST /documents/:parent/comments creates a comment (session)', async () => {
  const { app, seed } = await makeTestApp();
  const parent = await createParent(app, seed.sessionCookie, 'Parent A');
  const res = await app.request(parentPath(parent), {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'hello world' }),
  });
  expect(res.status).toBe(201);
  const j = await res.json();
  expect(j.data.type).toBe('comment');
  expect(j.data.slug).toMatch(/^c-/);
  expect(j.data.body).toBe('hello world');
  expect(j.data.frontmatter.author).toBe(`user:${seed.user.id}`);
  expect(j.data.frontmatter.kind).toBe('comment');
  expect(j.data.frontmatter.visibility).toBe('normal');
});

// -----------------------------------------------------------------------------
// 2. POST 422 INVALID_BODY — Zod shape rejection
// -----------------------------------------------------------------------------

test('POST 422 INVALID_BODY on missing body', async () => {
  const { app, seed } = await makeTestApp();
  const parent = await createParent(app, seed.sessionCookie, 'Parent B');
  const res = await app.request(parentPath(parent), {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('INVALID_BODY');
});

// -----------------------------------------------------------------------------
// 3. POST 404 when parent slug doesn't exist
// -----------------------------------------------------------------------------

test('POST 404 when parent slug unknown', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(parentPath('nope'), {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'whatever' }),
  });
  expect(res.status).toBe(404);
  expect((await res.json()).error.code).toBe('NOT_FOUND');
});

// -----------------------------------------------------------------------------
// 4. POST 422 INVALID_COMMENT_PARENT when parent is wrong type
// -----------------------------------------------------------------------------

test('POST 422 INVALID_COMMENT_PARENT when parent is an agent', async () => {
  const { app, seed } = await makeTestApp();
  // Create an agent at workspace scope. Since agents share the
  // `documents_workspace_type_slug_idx` namespace but project scoping isolates
  // slugs from project docs, we can't directly POST to /p/web/documents/agent-slug.
  // The agent's project_id is NULL, so the route's parent resolver (which scopes
  // by project_id) will NOT find it — yielding NOT_FOUND, not INVALID_COMMENT_PARENT.
  // To exercise INVALID_COMMENT_PARENT cleanly, we instead use a *comment* doc as
  // the parent — comments have the same project_id but type='comment', which the
  // service rejects with INVALID_COMMENT_PARENT.
  const parent = await createParent(app, seed.sessionCookie, 'Real Parent');
  const firstRes = await app.request(parentPath(parent), {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'first comment' }),
  });
  const firstSlug = (await firstRes.json()).data.slug as string;

  // Now try to comment on the comment.
  const res = await app.request(parentPath(firstSlug), {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'reply' }),
  });
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('INVALID_COMMENT_PARENT');
});

// -----------------------------------------------------------------------------
// 5. POST emits comment.created event
// -----------------------------------------------------------------------------

test('POST emits comment.created in the events log', async () => {
  const { app, seed } = await makeTestApp();
  const parent = await createParent(app, seed.sessionCookie, 'P');
  await app.request(parentPath(parent), {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'first' }),
  });

  const { db } = await import('../db/client.ts');
  const { events } = await import('../db/schema.ts');
  const { eq } = await import('drizzle-orm');
  const rows = await db.query.events.findMany({
    where: eq(events.kind, 'comment.created'),
  });
  expect(rows.length).toBe(1);
  const row = rows[0]!;
  expect(row.actor).toBe(seed.user.id);
  const payload = row.payload as Record<string, unknown>;
  expect(payload.kind).toBe('comment');
  expect(payload.author).toBe(`user:${seed.user.id}`);
  expect(typeof payload.parent_id).toBe('string');
});

// -----------------------------------------------------------------------------
// 6. GET list — newest-first, filter by ?kind=, filter by ?since=, default
//    visibility excludes internal
// -----------------------------------------------------------------------------

test('GET list returns newest-first and filters by ?kind= and ?since= and default visibility', async () => {
  const { app, seed } = await makeTestApp();
  const parent = await createParent(app, seed.sessionCookie, 'List Parent');

  // Three comments: a comment, a plan, an internal note.
  await app.request(parentPath(parent), {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'first comment' }),
  });
  // Wait so timestamps differ enough for `since` to bisect.
  await new Promise((r) => setTimeout(r, 5));
  const mid = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 5));
  await app.request(parentPath(parent), {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'plan body', kind: 'plan' }),
  });
  await new Promise((r) => setTimeout(r, 5));
  await app.request(parentPath(parent), {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'internal note', visibility: 'internal' }),
  });

  // Default visibility → 'normal' only; internal note excluded.
  const all = await app.request(parentPath(parent), { headers: { Cookie: seed.sessionCookie } });
  const allBody = await all.json();
  expect(allBody.data).toHaveLength(2);
  // Newest first — 'plan body' was created after 'first comment'.
  expect(allBody.data[0].frontmatter.kind).toBe('plan');
  expect(allBody.data[1].frontmatter.kind).toBe('comment');

  // ?kind=plan
  const planOnly = await app.request(`${parentPath(parent)}?kind=plan`, {
    headers: { Cookie: seed.sessionCookie },
  });
  const planBody = await planOnly.json();
  expect(planBody.data).toHaveLength(1);
  expect(planBody.data[0].frontmatter.kind).toBe('plan');

  // ?since=<mid> — only the plan + the internal note were created after.
  // The internal note is still excluded by default visibility.
  const sinceMid = await app.request(`${parentPath(parent)}?since=${encodeURIComponent(mid)}`, {
    headers: { Cookie: seed.sessionCookie },
  });
  const sinceBody = await sinceMid.json();
  expect(sinceBody.data).toHaveLength(1);
  expect(sinceBody.data[0].frontmatter.kind).toBe('plan');
});

// -----------------------------------------------------------------------------
// 7. GET list ?visibility=normal,internal includes internal
// -----------------------------------------------------------------------------

test('GET list ?visibility=normal,internal includes internal rows', async () => {
  const { app, seed } = await makeTestApp();
  const parent = await createParent(app, seed.sessionCookie, 'Internal Parent');
  await app.request(parentPath(parent), {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'normal one' }),
  });
  await app.request(parentPath(parent), {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'internal one', visibility: 'internal' }),
  });

  const res = await app.request(`${parentPath(parent)}?visibility=normal,internal`, {
    headers: { Cookie: seed.sessionCookie },
  });
  const j = await res.json();
  expect(j.data).toHaveLength(2);
});

// -----------------------------------------------------------------------------
// 8. GET single — returns soft-deleted rows
// -----------------------------------------------------------------------------

test('GET single returns soft-deleted comments', async () => {
  const { app, seed } = await makeTestApp();
  const parent = await createParent(app, seed.sessionCookie, 'SD Parent');
  const create = await app.request(parentPath(parent), {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'will be deleted' }),
  });
  const slug = (await create.json()).data.slug as string;

  await app.request(itemPath(slug), {
    method: 'DELETE',
    headers: { Cookie: seed.sessionCookie },
  });

  const got = await app.request(itemPath(slug), { headers: { Cookie: seed.sessionCookie } });
  expect(got.status).toBe(200);
  const j = await got.json();
  expect(j.data.body).toBe('');
  expect(j.data.frontmatter.deleted_at).toBeTruthy();
});

// -----------------------------------------------------------------------------
// 9. PATCH body change — sets edited_at, re-parses mentions
// -----------------------------------------------------------------------------

test('PATCH body sets edited_at', async () => {
  const { app, seed } = await makeTestApp();
  const parent = await createParent(app, seed.sessionCookie, 'PatchParent');
  const create = await app.request(parentPath(parent), {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'original' }),
  });
  const slug = (await create.json()).data.slug as string;

  const patch = await app.request(itemPath(slug), {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'edited' }),
  });
  expect(patch.status).toBe(200);
  const j = await patch.json();
  expect(j.data.body).toBe('edited');
  expect(j.data.frontmatter.edited_at).toBeTruthy();
});

// -----------------------------------------------------------------------------
// 10. PATCH 422 KIND_IMMUTABLE — service rejects kind on PATCH
// -----------------------------------------------------------------------------

test('PATCH 422 KIND_IMMUTABLE when client sends kind', async () => {
  const { app, seed } = await makeTestApp();
  const parent = await createParent(app, seed.sessionCookie, 'KindParent');
  const create = await app.request(parentPath(parent), {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'note' }),
  });
  const slug = (await create.json()).data.slug as string;

  const patch = await app.request(itemPath(slug), {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'plan' }),
  });
  expect(patch.status).toBe(422);
  expect((await patch.json()).error.code).toBe('KIND_IMMUTABLE');
});

// -----------------------------------------------------------------------------
// 11. PATCH 403 COMMENT_AUTHOR_ONLY
// -----------------------------------------------------------------------------

test('PATCH 403 COMMENT_AUTHOR_ONLY when non-author tries to edit', async () => {
  const { app, seed } = await makeTestApp();
  const parent = await createParent(app, seed.sessionCookie, 'AuthorOnly');
  const create = await app.request(parentPath(parent), {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'mine' }),
  });
  const slug = (await create.json()).data.slug as string;

  const bobCookie = await makeSecondUser(app, seed.workspace.id);
  const patch = await app.request(itemPath(slug), {
    method: 'PATCH',
    headers: { Cookie: bobCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'pwned' }),
  });
  expect(patch.status).toBe(403);
  expect((await patch.json()).error.code).toBe('COMMENT_AUTHOR_ONLY');
});

// -----------------------------------------------------------------------------
// 12. DELETE 200 — soft delete, body=''
// -----------------------------------------------------------------------------

test('DELETE returns soft-deleted row with empty body', async () => {
  const { app, seed } = await makeTestApp();
  const parent = await createParent(app, seed.sessionCookie, 'DelParent');
  const create = await app.request(parentPath(parent), {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'goodbye' }),
  });
  const slug = (await create.json()).data.slug as string;

  const del = await app.request(itemPath(slug), {
    method: 'DELETE',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(del.status).toBe(200);
  const j = await del.json();
  expect(j.data.body).toBe('');
  expect(j.data.frontmatter.deleted_at).toBeTruthy();
});

// -----------------------------------------------------------------------------
// 13. DELETE 403 — non-author can't delete
// -----------------------------------------------------------------------------

test('DELETE 403 COMMENT_AUTHOR_ONLY when non-author tries to delete', async () => {
  const { app, seed } = await makeTestApp();
  const parent = await createParent(app, seed.sessionCookie, 'DelAuthor');
  const create = await app.request(parentPath(parent), {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'mine to delete' }),
  });
  const slug = (await create.json()).data.slug as string;

  const bobCookie = await makeSecondUser(app, seed.workspace.id);
  const del = await app.request(itemPath(slug), {
    method: 'DELETE',
    headers: { Cookie: bobCookie },
  });
  expect(del.status).toBe(403);
  expect((await del.json()).error.code).toBe('COMMENT_AUTHOR_ONLY');
});

// -----------------------------------------------------------------------------
// 14. Bearer agent token POST — author is agent:<slug>
// -----------------------------------------------------------------------------

test('Bearer agent token POSTs a comment with author=agent:<id> (F11: id, not slug)', async () => {
  const { app, seed } = await makeTestApp();
  // Mint an agent with create_document → derives documents:write scope.
  const { data: agent } = await createAgentAtWorkspace(app, seed.sessionCookie, {
    type: 'agent',
    title: 'Bot',
    frontmatter: {
      system_prompt: 'x',
      model: 'x',
      provider: 'anthropic',
      tools: ['create_document', 'list_documents'],
    },
  });
  const agentId = agent.id as string;
  const agentToken = (agent as { agent_token: string }).agent_token;

  const parent = await createParent(app, seed.sessionCookie, 'Bot Target');
  const res = await app.request(parentPath(parent), {
    method: 'POST',
    headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'from the bot' }),
  });
  expect(res.status).toBe(201);
  const j = await res.json();
  // F11: canonical form is `agent:<id>`. Slugs are mutable; ids aren't.
  expect(j.data.frontmatter.author).toBe(`agent:${agentId}`);
});

// -----------------------------------------------------------------------------
// 15. Bearer scope enforcement — token without documents:write → 403
// -----------------------------------------------------------------------------

test('Bearer without documents:write → 403 FORBIDDEN_SCOPE on POST', async () => {
  const { app, seed } = await makeTestApp();
  // tools=['list_documents'] → scope set is just documents:read.
  const { data: agent } = await createAgentAtWorkspace(app, seed.sessionCookie, {
    type: 'agent',
    title: 'ReadOnly',
    frontmatter: {
      system_prompt: 'x',
      model: 'x',
      provider: 'anthropic',
      tools: ['list_documents'],
    },
  });
  const agentToken = (agent as { agent_token: string }).agent_token;

  const parent = await createParent(app, seed.sessionCookie, 'P');
  const res = await app.request(parentPath(parent), {
    method: 'POST',
    headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'nope' }),
  });
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('FORBIDDEN_SCOPE');
});

// -----------------------------------------------------------------------------
// 16. requireResource cross-allow-list block
// -----------------------------------------------------------------------------

test('Bearer narrowed to other project → 403 FORBIDDEN_RESOURCE', async () => {
  const { app, seed } = await makeTestApp();

  // Create a second project so the agent's allow-list can point at a real id.
  const createProj = await app.request('/api/v1/w/acme/projects', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Other', slug: 'other' }),
  });
  expect(createProj.status).toBe(201);
  const otherProjectId = (await createProj.json()).data.id as string;

  const { data: agent } = await createAgentAtWorkspace(app, seed.sessionCookie, {
    type: 'agent',
    title: 'Other-Only',
    frontmatter: {
      system_prompt: 'x',
      model: 'x',
      provider: 'anthropic',
      tools: ['create_document', 'list_documents'],
      projects: [otherProjectId],
    },
  });
  const agentToken = (agent as { agent_token: string }).agent_token;

  const parent = await createParent(app, seed.sessionCookie, 'Web Parent');
  const res = await app.request(parentPath(parent), {
    method: 'POST',
    headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'should not pass' }),
  });
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('FORBIDDEN_RESOURCE');
});

// -----------------------------------------------------------------------------
// F4 — REST single-comment routes must verify the slug belongs to :pslug.
//
// getComment() looks up by (workspace, slug, type='comment') only. Without an
// extra check, anyone with access to project A can read/edit/delete a comment
// that actually lives in project B by addressing it through project A's URL.
// The MCP variants at routes/mcp.ts:887 already do this; the REST handlers
// did not until this fix.
// -----------------------------------------------------------------------------

async function seedSecondProject(workspaceId: string): Promise<{ id: string; slug: string }> {
  const { nanoid } = await import('nanoid');
  const { db } = await import('../db/client.ts');
  const { projects } = await import('../db/schema.ts');
  const id = nanoid();
  const slug = 'projb';
  await db.insert(projects).values({ id, workspaceId, slug, name: 'Project B' });
  return { id, slug };
}

test('F4: GET /comments/:slug 404s when slug belongs to a different project than the URL', async () => {
  const { app, seed } = await makeTestApp();
  await seedSecondProject(seed.workspace.id);

  // Create the comment in project A (the seeded one — slug 'web').
  const parent = await createParent(app, seed.sessionCookie, 'P-A');
  const createRes = await app.request(parentPath(parent), {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'belongs to project A' }),
  });
  const created = (await createRes.json()).data as { slug: string };

  // Try to read it through project B's URL.
  const res = await app.request(`/api/v1/w/acme/p/projb/comments/${created.slug}`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(404);
  expect((await res.json()).error.code).toBe('NOT_FOUND');
});

test('F4: PATCH /comments/:slug 404s when slug belongs to a different project', async () => {
  const { app, seed } = await makeTestApp();
  await seedSecondProject(seed.workspace.id);

  const parent = await createParent(app, seed.sessionCookie, 'P-A');
  const createRes = await app.request(parentPath(parent), {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'A-only' }),
  });
  const created = (await createRes.json()).data as { slug: string };

  const res = await app.request(`/api/v1/w/acme/p/projb/comments/${created.slug}`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'tampered through wrong project' }),
  });
  expect(res.status).toBe(404);
  expect((await res.json()).error.code).toBe('NOT_FOUND');
});

test('F4: DELETE /comments/:slug 404s when slug belongs to a different project', async () => {
  const { app, seed } = await makeTestApp();
  await seedSecondProject(seed.workspace.id);

  const parent = await createParent(app, seed.sessionCookie, 'P-A');
  const createRes = await app.request(parentPath(parent), {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'A-only' }),
  });
  const created = (await createRes.json()).data as { slug: string };

  const res = await app.request(`/api/v1/w/acme/p/projb/comments/${created.slug}`, {
    method: 'DELETE',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(404);
  expect((await res.json()).error.code).toBe('NOT_FOUND');
});

// ---------------------------------------------------------------------------
// G5 — HTTP project-scoped PATCH/DELETE /:slug must reject type='comment'.
//
// F5 closed this on the MCP path but the HTTP project-scoped generic doc
// routes (PATCH/DELETE /api/v1/w/:wslug/p/:pslug/documents/:slug) had no
// type=comment guard, letting documents:write tokens bypass author-only,
// kind-immutable, edited_at, and soft-delete invariants.
// ---------------------------------------------------------------------------

test('G5: PATCH /documents/:slug (generic) rejects type=comment with COMMENT_REQUIRES_COMMENT_TOOL', async () => {
  const { app, seed } = await makeTestApp();
  const parent = await createParent(app, seed.sessionCookie, 'P');
  const createRes = await app.request(parentPath(parent), {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'original' }),
  });
  const comment = (await createRes.json()).data as { slug: string };

  const res = await app.request(`/api/v1/w/acme/p/web/documents/${comment.slug}`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'tampered via generic doc route' }),
  });
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('COMMENT_REQUIRES_COMMENT_TOOL');
});

test('G5: DELETE /documents/:slug (generic) rejects type=comment', async () => {
  const { app, seed } = await makeTestApp();
  const parent = await createParent(app, seed.sessionCookie, 'P');
  const createRes = await app.request(parentPath(parent), {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'original' }),
  });
  const comment = (await createRes.json()).data as { slug: string };

  const res = await app.request(`/api/v1/w/acme/p/web/documents/${comment.slug}`, {
    method: 'DELETE',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('COMMENT_REQUIRES_COMMENT_TOOL');
});

// ---------------------------------------------------------------------------
// F14 — listComments must reject malformed `since` rather than ignoring it.
//
// Before this fix an invalid `since` silently dropped the filter, returning
// the full list. A polling consumer would treat them all as new.
// ---------------------------------------------------------------------------

test('F14: GET list ?since=garbage returns 422 INVALID_QUERY', async () => {
  const { app, seed } = await makeTestApp();
  const parent = await createParent(app, seed.sessionCookie, 'P');
  // Seed at least one comment so the route reaches the filter step.
  await app.request(parentPath(parent), {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'first' }),
  });

  const res = await app.request(`${parentPath(parent)}?since=not-a-date`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('INVALID_QUERY');
});

test('F14: GET list with a valid ISO ?since= still works', async () => {
  const { app, seed } = await makeTestApp();
  const parent = await createParent(app, seed.sessionCookie, 'P');
  const res = await app.request(`${parentPath(parent)}?since=2025-01-01T00:00:00Z`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
});

// ---------------------------------------------------------------------------
// F11 — assertAuthor must NOT depend on the agent's mutable slug.
//
// Author strings are stored as 'agent:<slug>' historically; renaming an
// agent then breaks the author-only guard because resolveAuthorContext
// returns the CURRENT slug for the same agentId. Fix: store canonical
// 'agent:<id>' on new comments, accept either shape on the guard.
// ---------------------------------------------------------------------------

test('F11: agent author can edit own comment after its slug is renamed', async () => {
  const { app, db, seed } = await makeTestApp();
  const { nanoid } = await import('nanoid');
  const { apiTokens, documents } = await import('../db/schema.ts');
  const { newApiToken } = await import('../lib/auth.ts');
  const { eq } = await import('drizzle-orm');

  // 1. Create an agent document.
  const agentId = nanoid();
  await db.insert(documents).values({
    id: agentId,
    projectId: null,
    workspaceId: seed.workspace.id,
    tableId: null,
    type: 'agent',
    slug: 'original-name',
    title: 'Renameable Agent',
    status: null,
    body: '',
    frontmatter: {
      system_prompt: 'x', model: 'm', provider: 'anthropic',
      tools: ['create_document', 'create_comment', 'update_comment'],
      projects: ['*'],
    },
    createdBy: seed.user.id,
    updatedBy: seed.user.id,
  });
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    name: 'agent-token',
    tokenHash: hash,
    scopes: ['documents:read', 'documents:write'],
    createdBy: seed.user.id,
    agentId,
  });

  // 2. Agent posts a comment.
  const parent = await createParent(app, seed.sessionCookie, 'P');
  const postRes = await app.request(parentPath(parent), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'mine' }),
  });
  expect(postRes.status).toBe(201);
  const created = (await postRes.json()).data as { slug: string };

  // 3. Rename the agent's slug (mutating column directly mirrors update_agent).
  await db.update(documents).set({ slug: 'renamed' }).where(eq(documents.id, agentId));

  // 4. Same token (still bound by agentId) tries to edit its own comment.
  const patchRes = await app.request(itemPath(created.slug), {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'updated by same agent after rename' }),
  });
  expect(patchRes.status).toBe(200);
});

// ---------------------------------------------------------------------------
// F7 — updateComment must NOT operate on soft-deleted rows.
//
// Without this guard an author could DELETE a comment (body→'',
// deleted_at→ISO) then PATCH it back with new body. UI hides via
// deleted_at, but raw export / GET / SSE consumers see the resurrected
// body — soft-delete contract broken.
// ---------------------------------------------------------------------------

test('F7: PATCH on a soft-deleted comment returns 422 COMMENT_DELETED (no body resurrection)', async () => {
  const { app, seed } = await makeTestApp();
  const parent = await createParent(app, seed.sessionCookie, 'P');
  const createRes = await app.request(parentPath(parent), {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'will be deleted' }),
  });
  const created = (await createRes.json()).data as { slug: string };

  // Soft-delete.
  const delRes = await app.request(itemPath(created.slug), {
    method: 'DELETE',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(delRes.status).toBe(200);

  // Try to PATCH it back.
  const patchRes = await app.request(itemPath(created.slug), {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'resurrected' }),
  });
  expect(patchRes.status).toBe(422);
  expect((await patchRes.json()).error.code).toBe('COMMENT_DELETED');

  // GET still shows the deleted state with empty body.
  const getRes = await app.request(itemPath(created.slug), {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(getRes.status).toBe(200);
  const got = (await getRes.json()).data as { body: string; frontmatter: Record<string, unknown> };
  expect(got.body).toBe('');
  expect(got.frontmatter.deleted_at).toBeString();
});

test('F4: GET /comments/:slug still works when slug belongs to the URL project', async () => {
  const { app, seed } = await makeTestApp();
  const parent = await createParent(app, seed.sessionCookie, 'P-A');
  const createRes = await app.request(parentPath(parent), {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'same-project' }),
  });
  const created = (await createRes.json()).data as { slug: string };

  const res = await app.request(itemPath(created.slug), {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
});
