import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import * as schema from '../db/schema.ts';
import { apiTokens } from '../db/schema.ts';
import { createSession, newApiToken } from '../lib/auth.ts';
import { makeTestApp } from '../test/harness.ts';

/**
 * Seed a second user with the given workspace role and return a session cookie
 * for them. Used to prove the token-mint scope ceiling: a member must not be
 * able to mint a token carrying owner-only scopes (config:write / agents:write
 * / documents:delete) — the same roleToScopes ceiling the runner enforces.
 */
async function seedMemberSession(
  db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  workspaceId: string,
  role: 'owner' | 'admin' | 'member',
): Promise<string> {
  const userId = nanoid();
  await db.insert(schema.users).values({
    id: userId,
    email: `${userId}@test.local`,
    name: role,
  });
  // Post-tenancy: resolveWorkspace gates on workspace_access, so the seeded
  // session user needs a grant to REACH the route. The memberships row is
  // retained because tokens.ts still derives its scope ceiling from `m.role`
  // (a separate membership read rewired in a later task); users.role stays the
  // default 'member' for getRole() consumers.
  await db.insert(schema.memberships).values({ workspaceId, userId, role });
  await db.insert(schema.workspaceAccess).values({ userId, workspaceId });
  const session = await createSession(userId);
  return `folio_session=${session.id}`;
}

// POST /api/v1/w/:wslug/tokens/:workspaceId
// DELETE /api/v1/w/:wslug/tokens/:workspaceId/:tokenId
//
// B round 5 #1, #2 — tokens.ts POST + DELETE are session-only. A stolen
// workspace Bearer must not be able to mint a higher-scope replacement
// (POST) or revoke peer Bearers (DELETE). Threat model mitigation 11.

describe('tokens.ts requireSession gate (threat model mitigation 11)', () => {
  const tokensPath = (wslug: string, workspaceId: string) =>
    `/api/v1/w/${wslug}/tokens/${workspaceId}`;

  test('POST /tokens rejects API-token callers with 403', async () => {
    const { app, db, seed } = await makeTestApp();
    const { token, hash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      name: 'origin',
      tokenHash: hash,
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });
    const res = await app.request(tokensPath(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'pwn', scopes: ['documents:write'] }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  test('POST /tokens rejects bearer + garbage cookie with 403 (symmetry with ai.ts)', async () => {
    const { app, db, seed } = await makeTestApp();
    const { token, hash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      name: 'cookie-bypass',
      tokenHash: hash,
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });
    for (const garbageCookie of [
      'folio_session=garbage',
      'folio_session=',
      'folio_session=expired-id',
    ]) {
      const res = await app.request(tokensPath(seed.workspace.slug, seed.workspace.id), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: garbageCookie,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: 'pwn', scopes: ['documents:write'] }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe('FORBIDDEN');
    }
  });

  test('DELETE /tokens/:tokenId rejects API-token callers with 403', async () => {
    const { app, db, seed } = await makeTestApp();
    // Mint a peer token to attempt revoking.
    const peerId = nanoid();
    await db.insert(apiTokens).values({
      id: peerId,
      workspaceId: seed.workspace.id,
      name: 'peer',
      tokenHash: 'peer-hash',
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });
    // Mint the attacker token used for the bearer.
    const { token, hash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      name: 'attacker',
      tokenHash: hash,
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });
    const res = await app.request(
      `${tokensPath(seed.workspace.slug, seed.workspace.id)}/${peerId}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  test('DELETE /tokens/:tokenId rejects bearer + garbage cookie with 403', async () => {
    const { app, db, seed } = await makeTestApp();
    const peerId = nanoid();
    await db.insert(apiTokens).values({
      id: peerId,
      workspaceId: seed.workspace.id,
      name: 'peer',
      tokenHash: 'peer-hash',
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });
    const { token, hash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      name: 'attacker',
      tokenHash: hash,
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });
    const res = await app.request(
      `${tokensPath(seed.workspace.slug, seed.workspace.id)}/${peerId}`,
      {
        method: 'DELETE',
        headers: {
          Cookie: 'folio_session=garbage',
          Authorization: `Bearer ${token}`,
        },
      },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  // Happy path — session caller can still POST + DELETE.
  test('POST /tokens succeeds for a session caller', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(tokensPath(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: {
        Cookie: seed.sessionCookie,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'ci', scopes: ['documents:read'] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.data.token).toBe('string');
    expect(body.data.name).toBe('ci');
  });
});

// The mint endpoint must obey the SAME role→scope ceiling (roleToScopes) that
// the runner enforces at execution time. Without this, a member-tier user mints
// a token carrying owner-only scopes (config:write etc.) and uses it directly
// against the config routes — bypassing the entire agent∩caller ceiling at the
// one place a human creates raw authority.
describe('tokens.ts POST scope ceiling (no minting above your role)', () => {
  const tokensPath = (wslug: string, workspaceId: string) =>
    `/api/v1/w/${wslug}/tokens/${workspaceId}`;

  test('a member CANNOT mint a token carrying config:write (403)', async () => {
    const { app, db, seed } = await makeTestApp();
    const memberCookie = await seedMemberSession(db, seed.workspace.id, 'member');
    const res = await app.request(tokensPath(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: { Cookie: memberCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'escalate', scopes: ['documents:read', 'config:write'] }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN_SCOPE');
    // Nothing was minted.
    const rows = await db.query.apiTokens.findMany({
      where: eq(apiTokens.workspaceId, seed.workspace.id),
    });
    expect(rows.length).toBe(0);
  });

  test('a member CANNOT mint agents:write or documents:delete either (403)', async () => {
    const { app, db, seed } = await makeTestApp();
    const memberCookie = await seedMemberSession(db, seed.workspace.id, 'member');
    for (const scope of ['agents:write', 'documents:delete']) {
      const res = await app.request(tokensPath(seed.workspace.slug, seed.workspace.id), {
        method: 'POST',
        headers: { Cookie: memberCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'escalate', scopes: [scope] }),
      });
      expect(res.status).toBe(403);
    }
  });

  test('a member CAN mint a token within their ceiling (documents:read/write) (201)', async () => {
    const { app, db, seed } = await makeTestApp();
    const memberCookie = await seedMemberSession(db, seed.workspace.id, 'member');
    const res = await app.request(tokensPath(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: { Cookie: memberCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'member-ci', scopes: ['documents:read', 'documents:write'] }),
    });
    expect(res.status).toBe(201);
  });

  test('an owner CAN mint a token carrying config:write (201) — ceiling does not over-block', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(tokensPath(seed.workspace.slug, seed.workspace.id), {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'owner-config', scopes: ['documents:read', 'config:write'] }),
    });
    expect(res.status).toBe(201);
  });
});

// Post-tenancy access gate (drop-workspace-tenancy Task 8): a user may manage a
// workspace's tokens iff they can SEE that workspace (the access.ts convergence
// point), replacing the old `memberships`-row check. The handler gates on the
// `:workspaceId` PATH PARAM directly (it does not run resolveWorkspace on that
// param — resolveWorkspace keys off `:wslug`). These tests target the HANDLER's
// own canSeeWorkspace(:workspaceId) guard by pointing `:workspaceId` at a
// workspace B the caller cannot see, while `:wslug` is a workspace they CAN see
// (so resolveWorkspace passes and the handler guard is the operative gate).
describe('tokens.ts access gate: managing a workspace needs canSeeWorkspace (:workspaceId)', () => {
  const tokensPath = (wslug: string, workspaceId: string) =>
    `/api/v1/w/${wslug}/tokens/${workspaceId}`;

  // A member who can see `acme` (via workspace_access) but NOT workspace B.
  async function seedMemberAndUnseenWorkspace(
    db: Awaited<ReturnType<typeof makeTestApp>>['db'],
    seenWorkspaceId: string,
  ): Promise<{ cookie: string; unseenWorkspaceId: string }> {
    const cookie = await seedMemberSession(db, seenWorkspaceId, 'member');
    const unseenWorkspaceId = nanoid();
    await db.insert(schema.workspaces).values({
      id: unseenWorkspaceId,
      slug: `unseen-${unseenWorkspaceId}`,
      name: 'Unseen',
    });
    return { cookie, unseenWorkspaceId };
  }

  test('GET /tokens/:workspaceId → 403 when the caller cannot see :workspaceId', async () => {
    const { app, db, seed } = await makeTestApp();
    const { cookie, unseenWorkspaceId } = await seedMemberAndUnseenWorkspace(
      db,
      seed.workspace.id,
    );
    const res = await app.request(tokensPath(seed.workspace.slug, unseenWorkspaceId), {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
  });

  test('POST /tokens/:workspaceId → 403 when the caller cannot see :workspaceId (nothing minted)', async () => {
    const { app, db, seed } = await makeTestApp();
    const { cookie, unseenWorkspaceId } = await seedMemberAndUnseenWorkspace(
      db,
      seed.workspace.id,
    );
    const res = await app.request(tokensPath(seed.workspace.slug, unseenWorkspaceId), {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', scopes: ['documents:read'] }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN');
    const rows = await db.query.apiTokens.findMany({
      where: eq(apiTokens.workspaceId, unseenWorkspaceId),
    });
    expect(rows.length).toBe(0);
  });

  test('DELETE /tokens/:workspaceId/:tokenId → 403 when the caller cannot see :workspaceId (peer survives)', async () => {
    const { app, db, seed } = await makeTestApp();
    const { cookie, unseenWorkspaceId } = await seedMemberAndUnseenWorkspace(
      db,
      seed.workspace.id,
    );
    // A peer token pinned to the unseen workspace.
    const peerId = nanoid();
    await db.insert(apiTokens).values({
      id: peerId,
      workspaceId: unseenWorkspaceId,
      name: 'peer',
      tokenHash: 'peer-hash',
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });
    const res = await app.request(
      `${tokensPath(seed.workspace.slug, unseenWorkspaceId)}/${peerId}`,
      { method: 'DELETE', headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(403);
    // The peer token still exists — the no-access caller could not revoke it.
    const row = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, peerId) });
    expect(row).toBeDefined();
  });
});

// A7 — instance reach gate. api_tokens.workspace_id is nullable (null = instance
// reach). Only an instance admin (owner/admin of __system) may mint a reach=null
// token (T1). A normal mint pins to the URL workspace (back-compat). Reach is
// immutable — there is no route that mutates an existing token's workspace_id (T2).
describe('tokens.ts A7 instance reach gate (T1/T2)', () => {
  const tokensPath = (wslug: string, workspaceId: string) =>
    `/api/v1/w/${wslug}/tokens/${workspaceId}`;

  test('instance-admin (users.role owner) mints a reach=null token', async () => {
    const { app, db, seed } = await makeTestApp();
    // Make a NEW user U an instance owner (users.role) with access to acme.
    const userId = nanoid();
    await db.insert(schema.users).values({
      id: userId,
      email: `${userId}@test.local`,
      name: 'inst-admin',
      role: 'owner',
    });
    // resolveWorkspace on /w/acme gates on workspace_access. Grant it so the
    // instance-admin reaches the route; requireInstanceAdmin (the scope-ceiling
    // gate inside tokens.ts) reads users.role.
    await db.insert(schema.workspaceAccess).values({ userId, workspaceId: seed.workspace.id });
    const session = await createSession(userId);
    const cookie = `folio_session=${session.id}`;

    const res = await app.request(tokensPath('acme', seed.workspace.id), {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'inst', scopes: ['documents:read'], workspaceId: null }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.instance).toBe(true);

    const row = await db.query.apiTokens.findFirst({
      where: eq(apiTokens.id, body.data.id),
    });
    expect(row).toBeDefined();
    expect(row?.workspaceId).toBeNull();
  });

  test('a non-admin (member) requesting workspaceId:null → 403', async () => {
    const { app, db, seed } = await makeTestApp();
    // A member of acme who is NOT an instance admin.
    const memberCookie = await seedMemberSession(db, seed.workspace.id, 'member');
    const res = await app.request(tokensPath('acme', seed.workspace.id), {
      method: 'POST',
      headers: { Cookie: memberCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', scopes: ['documents:read'], workspaceId: null }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
    // No instance-reach token was minted.
    const rows = await db.query.apiTokens.findMany();
    expect(rows.filter((r) => r.workspaceId === null).length).toBe(0);
  });

  test('omitting workspaceId pins to the URL workspace (back-compat)', async () => {
    const { app, db, seed } = await makeTestApp();
    const res = await app.request(tokensPath('acme', seed.workspace.id), {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'pinned', scopes: ['documents:read'] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    const row = await db.query.apiTokens.findFirst({
      where: eq(apiTokens.id, body.data.id),
    });
    expect(row?.workspaceId).toBe(seed.workspace.id);
  });

  test('reach is immutable — no PATCH route (T2)', async () => {
    const { app, seed } = await makeTestApp();
    const res = await app.request(`${tokensPath('acme', seed.workspace.id)}/sometoken`, {
      method: 'PATCH',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: null }),
    });
    expect([404, 405].includes(res.status)).toBe(true);
  });
});

// A12 — instance-token listing surface. The per-workspace list filters
// `WHERE workspace_id = <id>`, which EXCLUDES instance (null) tokens, leaving
// them invisible to management. GET /api/v1/instance/tokens lists them, gated to
// a __system owner/admin SESSION (T1 parity with the A7 mint gate). Never returns
// tokenHash.
describe('A12: instance-token listing surface', () => {
  const instancePath = '/api/v1/instance/tokens';

  test('an instance owner lists instance tokens (and per-workspace tokens are excluded)', async () => {
    const { app, db, seed } = await makeTestApp();
    // seed.user is the instance owner (users.role = 'owner', set by the harness),
    // which is what requireInstanceAdmin now reads.

    // An INSTANCE token (workspaceId null) + a normal acme-pinned token.
    const inst = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: null,
      name: 'inst',
      tokenHash: inst.hash,
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });
    const pinned = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      name: 'pinned',
      tokenHash: pinned.hash,
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });

    const res = await app.request(instancePath, {
      headers: { Cookie: seed.sessionCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const names = body.data.tokens.map((t: { name: string }) => t.name);
    expect(names).toContain('inst');
    expect(names).not.toContain('pinned');
    // The instance token carries a null workspace_id.
    const instRow = body.data.tokens.find((t: { name: string }) => t.name === 'inst');
    expect(instRow.workspaceId).toBeNull();
    // Never leak tokenHash.
    for (const t of body.data.tokens) {
      expect('tokenHash' in t).toBe(false);
    }
  });

  test('a non-instance-admin (users.role member) is forbidden from the instance-token list (403)', async () => {
    const { app, db, seed } = await makeTestApp();
    // A genuine non-admin: users.role defaults to 'member'. (seed.user is the
    // instance owner now, so it can't stand in for the forbidden case anymore —
    // we mint a fresh member-role session to preserve the security intent.)
    const memberCookie = await seedMemberSession(db, seed.workspace.id, 'member');
    const res = await app.request(instancePath, {
      headers: { Cookie: memberCookie },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('FORBIDDEN');
  });

  test('a bearer cannot reach the instance-token list (session-only)', async () => {
    const { app, db, seed } = await makeTestApp();
    const { token, hash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      name: 'bearer',
      tokenHash: hash,
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });
    const res = await app.request(instancePath, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect([401, 403]).toContain(res.status);
  });
});
