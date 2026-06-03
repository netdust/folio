import { expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { apiTokens, documents, memberships, users, workspaces } from '../db/schema.ts';
import { newApiToken } from '../lib/auth.ts';
import {
  SYSTEM_WORKSPACE_SLUG,
  bootstrapSystemWorkspace,
  designateInstanceOwner,
  findSystemOwnerId,
  grantOwner,
} from '../lib/system-workspace.ts';
import { describe } from 'bun:test';
import { isSystemMember, listWorkspaces } from '../services/workspaces.ts';
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

test('GET /api/v1/w/:wslug reports claude_code_enabled:false even when FOLIO_CLAUDE_CODE_ENABLED is true', async () => {
  // Phase C shake-out: claude-code is hard-disabled at the runner preflight, so
  // the workspace endpoint must NEVER advertise it as selectable — even when the
  // env flag is on. The flag no longer enables execution; surfacing it would let
  // the web UI offer a provider option that always fails.
  const { env } = await import('../env.ts');
  const prev = env.FOLIO_CLAUDE_CODE_ENABLED;
  (env as { FOLIO_CLAUDE_CODE_ENABLED: boolean }).FOLIO_CLAUDE_CODE_ENABLED = true;
  try {
    const { app, seed } = await makeTestApp();
    const res = await app.request('/api/v1/w/acme', {
      headers: { Cookie: seed.sessionCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.claude_code_enabled).toBe(false);
  } finally {
    (env as { FOLIO_CLAUDE_CODE_ENABLED: boolean }).FOLIO_CLAUDE_CODE_ENABLED = prev;
  }
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

// --- Phase D (D1): __system is excluded from the AMBIENT workspace list (the
// switcher) but stays reachable by direct slug navigation for a member. The
// library is curated through its own settings entry, not the workspace pin
// switcher — so a __system membership must not surface as a switchable row.

test('listWorkspaces excludes __system from the ambient list (D1)', async () => {
  const { db, seed } = await makeTestApp();
  await bootstrapSystemWorkspace(db);
  // Make the seed user (alice) the __system instance owner.
  await grantOwner(db, seed.user.email);

  const rows = await listWorkspaces(seed.user.id);
  // alice's own 'acme' workspace is present; __system is filtered out.
  expect(rows.some((r) => r.workspace.slug === 'acme')).toBe(true);
  expect(rows.some((r) => r.workspace.slug === SYSTEM_WORKSPACE_SLUG)).toBe(false);
});

test('isSystemMember is true for a __system member, false otherwise (D1)', async () => {
  const { app, db, seed } = await makeTestApp();
  await bootstrapSystemWorkspace(db);

  // Before designation alice is not a __system member.
  expect(await isSystemMember(seed.user.id)).toBe(false);

  await grantOwner(db, seed.user.email);
  expect(await isSystemMember(seed.user.id)).toBe(true);

  // A wholly unrelated user (not in __system) reads false.
  const res = await app.request('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'bob@test.local',
      name: 'Bob',
      password: 'password123',
    }),
  });
  // Registration may or may not be open in this harness; fall back to a direct
  // insert if the route declines, so the assertion stays deterministic.
  let bobId: string;
  if (res.status === 200 || res.status === 201) {
    const bob = await db.query.users.findFirst({
      where: eq(users.email, 'bob@test.local'),
    });
    bobId = bob!.id;
  } else {
    bobId = nanoid();
    await db.insert(users).values({
      id: bobId,
      email: 'bob2@test.local',
      name: 'Bob',
      passwordHash: 'x',
    });
  }
  expect(await isSystemMember(bobId)).toBe(false);
});

test('GET /api/v1/w/__system still resolves the workspace for a member (filter does not break navigation) (D1)', async () => {
  const { app, db, seed } = await makeTestApp();
  await bootstrapSystemWorkspace(db);
  await grantOwner(db, seed.user.email);

  // Direct slug navigation to __system must still return 200 for a MEMBER even
  // though listWorkspaces excludes it. The detail route is membership-gated via
  // resolveWorkspace — NOT via listWorkspaces — so the ambient filter cannot
  // break navigation.
  const res = await app.request(`/api/v1/w/${SYSTEM_WORKSPACE_SLUG}`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.slug).toBe(SYSTEM_WORKSPACE_SLUG);
});

// --- A10: instance bearer (workspaceId null + workspace:admin) can create
// workspaces. The operator / an instance admin's automation can now provision
// workspaces; a pinned/agent bearer, or an instance bearer lacking
// workspace:admin, stays rejected (M7 preserved). The reserved-slug guard in
// the handler is independent of auth.

test('A10: an instance bearer with workspace:admin creates a workspace (201)', async () => {
  const { app, db, seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: null,
    name: 'inst-admin',
    tokenHash: hash,
    scopes: ['workspace:admin', 'documents:read'],
    createdBy: seed.user.id,
  });
  const res = await app.request('/api/v1/workspaces', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'New WS' }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  const wsId = body.data.id;
  const row = await db.query.workspaces.findFirst({ where: eq(workspaces.id, wsId) });
  expect(row).toBeDefined();
  // Owner membership is created against the token's createdBy (the human admin
  // hydrated by attachToken) — A7.
  const owner = await db.query.memberships.findFirst({
    where: and(eq(memberships.workspaceId, wsId), eq(memberships.role, 'owner')),
  });
  expect(owner?.userId).toBe(seed.user.id);
});

test('A10: a pinned member bearer cannot create a workspace (403)', async () => {
  const { app, db, seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    name: 'pinned-member',
    tokenHash: hash,
    scopes: ['documents:read'],
    createdBy: seed.user.id,
  });
  const res = await app.request('/api/v1/workspaces', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Nope' }),
  });
  expect(res.status).toBe(403);
});

test('A10: an instance bearer WITHOUT workspace:admin cannot create (403)', async () => {
  const { app, db, seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: null,
    name: 'inst-no-admin',
    tokenHash: hash,
    scopes: ['documents:read'],
    createdBy: seed.user.id,
  });
  const res = await app.request('/api/v1/workspaces', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Nope' }),
  });
  expect(res.status).toBe(403);
});

test('A10: an instance bearer cannot create a reserved __system slug (400)', async () => {
  const { app, db, seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: null,
    name: 'inst-admin-reserved',
    tokenHash: hash,
    scopes: ['workspace:admin', 'documents:read'],
    createdBy: seed.user.id,
  });
  const res = await app.request('/api/v1/workspaces', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x', slug: '__system' }),
  });
  // The reserved-slug guard is independent of auth. An explicit `__system`
  // slug is rejected at the create-zod regex (`^[a-z0-9-]+$` forbids the
  // leading underscore → 400 ZodError); assertSlugAllowed in the handler is
  // defense-in-depth on the FINAL resolved slug below that layer. Either way
  // an authorized instance bearer creates NO __system workspace.
  expect([400, 422]).toContain(res.status);
  const sys = await db.query.workspaces.findFirst({
    where: eq(workspaces.slug, '__system'),
  });
  expect(sys).toBeUndefined();
});

test('A10: session user still creates a workspace (regression)', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/workspaces', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'A10 Session' }),
  });
  expect(res.status).toBe(201);
});

// --- CR#2: the OPERATOR (the user-less instance bearer, createdBy=null) can
// create a workspace, owned by the __system owner. The existing A10 test above
// covers a human-minted instance bearer (createdBy=<user>) whose owner is the
// hydrated user; this exercises the DISTINCT createdBy=null path where there is
// NO hydrated user and the handler must fall back to findSystemOwnerId(db).
describe('CR#2: operator/instance-bearer workspace create', () => {
  test('operator token (createdBy=null) with workspace:admin creates a workspace owned by the __system owner', async () => {
    const { app, db, seed } = await makeTestApp();
    // Bootstrap __system and designate seed.user (alice) as the instance owner —
    // this is what gives findSystemOwnerId a single owner to resolve.
    await bootstrapSystemWorkspace(db);
    await designateInstanceOwner(db, seed.user.email);
    const systemOwnerId = await findSystemOwnerId(db);
    expect(systemOwnerId).toBe(seed.user.id);

    // Mint the OPERATOR-shaped token: instance reach (workspaceId null), NO
    // human creator (createdBy null — the unforgeable system-origin marker),
    // owner-equivalent admin scope. NO cookie: the user-less bearer path.
    const { token, hash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: null,
      name: 'operator-style',
      tokenHash: hash,
      scopes: ['workspace:admin', 'documents:read'],
      createdBy: null,
    });

    const res = await app.request('/api/v1/workspaces', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Op WS' }),
    });
    expect(res.status).toBe(201);
    const wsId = (await res.json()).data.id as string;

    // The workspace row exists...
    const row = await db.query.workspaces.findFirst({ where: eq(workspaces.id, wsId) });
    expect(row).toBeDefined();

    // ...and its owner membership is assigned to the __system owner (alice),
    // NOT to a (non-existent) hydrated user — proving the findSystemOwnerId
    // fallback fired.
    const owner = await db.query.memberships.findFirst({
      where: and(eq(memberships.workspaceId, wsId), eq(memberships.role, 'owner')),
    });
    expect(owner).toBeDefined();
    // systemOwnerId === seed.user.id (asserted above); compare to the definite
    // string so the assertion stays well-typed.
    expect(owner!.userId).toBe(seed.user.id);
  });
});
