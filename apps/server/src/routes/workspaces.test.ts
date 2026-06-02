import { expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { apiTokens, documents, workspaces } from '../db/schema.ts';
import { newApiToken } from '../lib/auth.ts';
import { bootstrapSystemWorkspace } from '../lib/system-workspace.ts';
import { makeTestApp } from '../test/harness.ts';
import { assertSlugAllowed } from './workspaces.ts';

test('GET /api/v1/workspaces lists user workspaces', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/workspaces', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data).toHaveLength(1);
  expect(body.data[0].workspace.slug).toBe('acme');
  expect(body.data[0].role).toBe('owner');
});

test('GET /api/v1/workspaces 401 without cookie', async () => {
  const { app } = await makeTestApp();
  const res = await app.request('/api/v1/workspaces');
  expect(res.status).toBe(401);
});

test('POST /api/v1/workspaces creates with derived slug', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/workspaces', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'New Place' }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.data.slug).toMatch(/^new-place/);
});

test('POST /api/v1/workspaces auto-seeds 4 builtin triggers', async () => {
  const { app, seed, db } = await makeTestApp();
  const res = await app.request('/api/v1/workspaces', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'New Co', slug: 'newco' }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();

  const triggers = await db
    .select()
    .from(documents)
    .where(and(eq(documents.workspaceId, body.data.id), eq(documents.type, 'trigger')));

  const slugs = triggers.map((t) => t.slug).sort();
  expect(slugs).toEqual([
    'builtin-on-approval',
    'builtin-on-assignment',
    'builtin-on-mention',
    'builtin-on-rejection',
  ]);

  // All 4 are marked builtin: true.
  for (const t of triggers) {
    const fm = t.frontmatter as Record<string, unknown>;
    expect(fm.builtin).toBe(true);
  }

  // Enabled defaults per spec §6f (updated Phase 3 / Task A-3: runner-bound
  // builtins now start enabled because the runner exists).
  const byslug = Object.fromEntries(triggers.map((t) => [t.slug, t]));
  expect((byslug['builtin-on-assignment']!.frontmatter as Record<string, unknown>).enabled).toBe(true);
  expect((byslug['builtin-on-mention']!.frontmatter as Record<string, unknown>).enabled).toBe(true);
  expect((byslug['builtin-on-approval']!.frontmatter as Record<string, unknown>).enabled).toBe(true);
  expect((byslug['builtin-on-rejection']!.frontmatter as Record<string, unknown>).enabled).toBe(true);

  // projectId is null (workspace-scoped).
  for (const t of triggers) {
    expect(t.projectId).toBeNull();
  }
});

test('POST with explicit slug; second use is 409', async () => {
  const { app, seed } = await makeTestApp();
  await app.request('/api/v1/workspaces', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Foo', slug: 'taken' }),
  });
  const dupe = await app.request('/api/v1/workspaces', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Bar', slug: 'taken' }),
  });
  expect(dupe.status).toBe(409);
  expect((await dupe.json()).error.code).toBe('SLUG_CONFLICT');
});

// Phase A (M2/M3) — reserved (underscore-prefixed) slugs cannot be created.
// The create zod regex `^[a-z0-9-]+$` rejects underscores at validation (422);
// assertSlugAllowed is defense-in-depth on the FINAL resolved slug (both the
// explicit and the auto-derived branch) so loosening that regex can never
// silently reopen the system-workspace hijack.
test('POST /api/v1/workspaces rejects reserved __system slug; nothing created', async () => {
  const { app, seed, db } = await makeTestApp();
  const res = await app.request('/api/v1/workspaces', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Hijack', slug: '__system' }),
  });
  // 422 from the create regex; the explicit assertSlugAllowed guard sits below it.
  expect([400, 422]).toContain(res.status);
  const row = await db.query.workspaces.findFirst({
    where: eq(workspaces.slug, '__system'),
  });
  expect(row).toBeUndefined();
});

// Unit-exercise the exported guard directly — this is what observably proves
// the reserved-slug logic independent of the zod regex (the both-branches
// final-slug assertion in the CREATE handler).
test('assertSlugAllowed throws on reserved slugs, passes normal ones', () => {
  expect(() => assertSlugAllowed('__system')).toThrow();
  expect(() => assertSlugAllowed('_x')).toThrow();
  expect(() => assertSlugAllowed('acme')).not.toThrow();
});

// M3 satisfied structurally by slug immutability — the PATCH zod schema is
// `{ name }`-only, so a stray `slug` is stripped and the slug cannot be
// renamed to a reserved value. Pin this contract.
test('PATCH /api/v1/w/:wslug ignores a stray slug field; slug stays acme', async () => {
  const { app, seed, db } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme', {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Renamed', slug: '__system' }),
  });
  expect(res.status).toBe(200);
  const row = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, seed.workspace.id),
  });
  expect(row?.slug).toBe('acme');
});

test('GET /api/v1/workspaces/:wslug returns workspace + role', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.slug).toBe('acme');
  expect(body.data.role).toBe('owner');
});

test('PATCH /api/v1/workspaces/:wslug renames (owner)', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme', {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Acme Inc' }),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).data.name).toBe('Acme Inc');
});

test('DELETE /api/v1/workspaces/:wslug 204 (owner)', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme', {
    method: 'DELETE',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(204);
});

test('GET /api/v1/w/:wslug/members returns id/name/email/role for each membership', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/members', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { members: { id: string; email: string; name: string; role: string }[] };
  };
  expect(Array.isArray(body.data.members)).toBe(true);
  expect(body.data.members.length).toBe(1);
  const m = body.data.members[0]!;
  expect(m.id).toBe(seed.user.id);
  expect(m.email).toBe('alice@test.local');
  expect(m.role).toBe('owner');
});

test('GET /api/v1/w/:wslug/members 401 without auth', async () => {
  const { app } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/members');
  expect(res.status).toBe(401);
});

// Round 7 #22 — GET /members narrowing by agent allow-list.
//
// Threat model attack 21 + mitigation 22. F3 (events.ts) narrows event
// visibility for agent-bound bearers whose frontmatter.projects is not
// wildcard; this route had no parallel. An agent allow-listed to one
// project was receiving the email roster of users on every project.
//
// v1 implementation: project-narrowed agent-bound bearers receive an
// empty list. Wildcard agents + session callers see the full list.
test('Round 7 #22: GET /members returns empty list for project-narrowed agent-bound token', async () => {
  const { app, db, seed } = await makeTestApp();
  // Create the agent doc with a narrow projects allow-list.
  const res1 = await app.request('/api/v1/w/acme/documents', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'agent', title: 'Narrowed Agent',
      frontmatter: {
        system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [],
        projects: [seed.project.id],
      },
    }),
  });
  expect(res1.status).toBe(201);
  const agent = (await res1.json()).data as { id: string };

  // Mint a bearer token bound to that agent.
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    name: 'narrowed-bound',
    tokenHash: hash,
    scopes: ['documents:read'],
    createdBy: seed.user.id,
    agentId: agent.id,
  });

  const res = await app.request('/api/v1/w/acme/members', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { members: unknown[] } };
  expect(body.data.members).toEqual([]);
});

test('Round 7 #22: GET /members returns full list for wildcard-allow-list agent-bound token', async () => {
  const { app, db, seed } = await makeTestApp();
  // Create an agent with projects:['*'] (workspace-wide).
  const res1 = await app.request('/api/v1/w/acme/documents', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'agent', title: 'Wildcard Agent',
      frontmatter: {
        system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [],
        projects: ['*'],
      },
    }),
  });
  expect(res1.status).toBe(201);
  const agent = (await res1.json()).data as { id: string };

  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    name: 'wildcard-bound',
    tokenHash: hash,
    scopes: ['documents:read'],
    createdBy: seed.user.id,
    agentId: agent.id,
  });

  const res = await app.request('/api/v1/w/acme/members', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { members: { id: string }[] };
  };
  expect(body.data.members.length).toBeGreaterThan(0);
});

// B round 5 #3 — workspace identity mutations (PATCH rename, DELETE) are
// session-only. Pre-fix a stolen Bearer whose createdBy resolves to the
// workspace owner could rename or delete the workspace via the bearer chain
// (attachToken hydrates user from token.createdBy, requireUser is satisfied).
// requireSession rejects authMethod === 'token' with 403. Threat model
// mitigation 11.

test('PATCH /api/v1/w/:wslug rejects API-token callers with 403', async () => {
  const { app, db, seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    name: 'rename-attacker',
    tokenHash: hash,
    scopes: ['documents:read'],
    createdBy: seed.user.id,
  });
  const res = await app.request('/api/v1/w/acme', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ name: 'PWNED' }),
  });
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.error.code).toBe('FORBIDDEN');
});

test('PATCH /api/v1/w/:wslug rejects bearer + garbage cookie with 403', async () => {
  const { app, db, seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    name: 'cookie-bypass-attacker',
    tokenHash: hash,
    scopes: ['documents:read'],
    createdBy: seed.user.id,
  });
  const res = await app.request('/api/v1/w/acme', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: 'folio_session=garbage',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ name: 'PWNED' }),
  });
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.error.code).toBe('FORBIDDEN');
});

test('DELETE /api/v1/w/:wslug rejects API-token callers with 403', async () => {
  const { app, db, seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    name: 'delete-attacker',
    tokenHash: hash,
    scopes: ['documents:read'],
    createdBy: seed.user.id,
  });
  const res = await app.request('/api/v1/w/acme', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.error.code).toBe('FORBIDDEN');
});

// Round 7 #21 — POST /api/v1/workspaces gets explicit requireSessionUser.
//
// Pre-round-7 the route was session-only by routing topology: workspacesRoute
// mounts at v1 (no wScope), attachToken never runs, so `authMethod` stays
// undefined and the upstream `requireUser` produces 401 for bearer-only
// callers. That's contract-via-implementation. A future middleware refactor
// that hoists attachToken would silently turn this bearer-reachable.
//
// Threat model attack 20 + mitigation 21. The explicit gate is a no-op
// today (bearer-only requests still don't authenticate as 'session') but
// pins the contract against future routing changes.
test('Round 7 #21: POST /api/v1/workspaces 401 for no auth', async () => {
  const { app } = await makeTestApp();
  const res = await app.request('/api/v1/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'NoAuth' }),
  });
  expect(res.status).toBe(401);
  expect((await res.json()).error.code).toBe('UNAUTHENTICATED');
});

test('Round 7 #21: POST /api/v1/workspaces accepts session callers (status 201)', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/workspaces', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Session Created' }),
  });
  expect(res.status).toBe(201);
});

// Round 6 #4 — symmetric to the PATCH garbage-cookie test above. Round 5 #10
// added the bearer + garbage cookie variant on settings.ts DELETE but missed
// the workspaces.ts DELETE equivalent. A garbage-cookie + valid-bearer request
// authenticates as 'token' (round 3 fix #1) — must hit the requireSessionUser
// composite's 403 branch, not slip into the 401 branch.
test('DELETE /api/v1/w/:wslug rejects bearer + garbage cookie with 403', async () => {
  const { app, db, seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    name: 'delete-cookie-bypass-attacker',
    tokenHash: hash,
    scopes: ['documents:read'],
    createdBy: seed.user.id,
  });
  const res = await app.request('/api/v1/w/acme', {
    method: 'DELETE',
    headers: {
      Cookie: 'folio_session=garbage',
      Authorization: `Bearer ${token}`,
    },
  });
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.error.code).toBe('FORBIDDEN');
});

// --- Phase A: __system is membership-gated like any workspace (M6) + workspace
// create stays session-only so agents can't reach __system (M7). These pin the
// boundary; Phase A adds NO __system read path that bypasses membership (the
// definitional skill-load exemption is Phase B).

test('M6: a non-__system member cannot read a __system workspace (membership gate)', async () => {
  const { app, db, seed } = await makeTestApp();
  // seed.user (alice) is a member of 'acme', NOT of __system.
  await bootstrapSystemWorkspace(db);
  // Reach __system as alice's session — resolveWorkspace's membership check fires.
  const res = await app.request('/api/v1/w/__system', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('FORBIDDEN');
});

test('M6: a non-__system member cannot read a __system page document', async () => {
  const { app, db, seed } = await makeTestApp();
  await bootstrapSystemWorkspace(db);
  // The seeded folio skill page lives in __system/skills. Alice (non-member)
  // is blocked at resolveWorkspace before reaching the document.
  const res = await app.request('/api/v1/w/__system/p/skills/documents/folio', {
    headers: { Cookie: seed.sessionCookie },
  });
  // 403 (not a member) — never 200/leaked content.
  expect([403, 404]).toContain(res.status);
  expect(res.status).not.toBe(200);
});

test('M7/M2: an agent bearer cannot create a __system workspace (session-only)', async () => {
  const { app, db, seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    name: 'agent-tries-system-create',
    tokenHash: hash,
    scopes: ['documents:read'],
    createdBy: seed.user.id,
  });
  const res = await app.request('/api/v1/workspaces', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Sneaky', slug: '__system' }),
  });
  // requireSessionUser rejects the bearer (401/403) before the slug check; either
  // way no __system workspace is created.
  expect([401, 403]).toContain(res.status);
  const sys = await db.query.workspaces.findFirst({
    where: eq(workspaces.slug, '__system'),
  });
  expect(sys).toBeUndefined();
});
