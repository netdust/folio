import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import * as schema from '../db/schema.ts';
import { apiTokens } from '../db/schema.ts';
import { createSession, newApiToken } from '../lib/auth.ts';
import { grantOwner } from '../lib/system-workspace.ts';
import { makeTestApp } from '../test/harness.ts';

/**
 * Seed a fresh user with the given INSTANCE role (users.role) and return their
 * session cookie. Post-tenancy, requireInstanceAdmin reads users.role — so a
 * 'member' here is a genuine non-instance-admin (the forbidden case). The route
 * is session-only (mounted on v1, no wScope), so no workspace_access grant is
 * needed to reach it.
 */
async function seedRoleSession(
  db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  role: 'owner' | 'admin' | 'member',
): Promise<string> {
  const userId = nanoid();
  await db.insert(schema.users).values({
    id: userId,
    email: `${userId}@test.local`,
    name: role,
    role,
  });
  const session = await createSession(userId);
  return `folio_session=${session.id}`;
}

/**
 * A12 / CR#5 — instance-token administration surface (list + revoke).
 *
 * Instance tokens carry `workspace_id IS NULL` (reach across every workspace,
 * minted only by a __system owner/admin). They are invisible + un-revocable via
 * the per-workspace token surfaces (those filter `WHERE workspace_id = <id>`),
 * so this route is the only HTTP path that can list/revoke them. Gate: SESSION
 * user who is a __system owner/admin; never returns tokenHash.
 */

/** Seed an instance token (workspace_id null). Returns its id. */
async function seedInstanceToken(
  db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  createdBy: string,
): Promise<string> {
  const { hash } = newApiToken();
  const id = nanoid();
  await db.insert(apiTokens).values({
    id,
    workspaceId: null,
    name: 'inst-tok',
    tokenHash: hash,
    scopes: ['workspace:admin', 'documents:read'],
    createdBy,
  });
  return id;
}

/** Seed a normal workspace-pinned token. Returns its id. */
async function seedPinnedToken(
  db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  workspaceId: string,
  createdBy: string,
): Promise<string> {
  const { hash } = newApiToken();
  const id = nanoid();
  await db.insert(apiTokens).values({
    id,
    workspaceId,
    name: 'pinned-tok',
    tokenHash: hash,
    scopes: ['documents:read'],
    createdBy,
  });
  return id;
}

describe('CR#5: DELETE /api/v1/instance/tokens/:id (revoke instance token)', () => {
  test('a __system owner revokes an instance token (200) and the row is gone', async () => {
    const { app, db, seed } = await makeTestApp();
    await grantOwner(db, seed.user.email); // alice becomes the __system owner
    const tokId = await seedInstanceToken(db, seed.user.id);

    const res = await app.request(`/api/v1/instance/tokens/${tokId}`, {
      method: 'DELETE',
      headers: { Cookie: seed.sessionCookie },
    });
    expect(res.status).toBe(200);

    const row = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, tokId) });
    expect(row).toBeUndefined();
  });

  test('revoke refuses to delete a WORKSPACE-scoped token (404); the row survives', async () => {
    const { app, db, seed } = await makeTestApp();
    await grantOwner(db, seed.user.email);
    // A pinned (non-null workspace) token — the isNull(workspaceId) guard means
    // the DELETE WHERE never matches it.
    const pinnedId = await seedPinnedToken(db, seed.workspace.id, seed.user.id);

    const res = await app.request(`/api/v1/instance/tokens/${pinnedId}`, {
      method: 'DELETE',
      headers: { Cookie: seed.sessionCookie },
    });
    expect(res.status).toBe(404);

    // The pinned token still exists — the instance-token route cannot reach it.
    const row = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, pinnedId) });
    expect(row).toBeDefined();
  });

  test('a non-instance-admin (users.role member) cannot revoke (403)', async () => {
    const { app, db, seed } = await makeTestApp();
    // A genuine non-admin: users.role 'member'. (seed.user is the instance owner
    // now, so it can't stand in for the forbidden case — we use a member-role
    // session to preserve the security intent.)
    const memberCookie = await seedRoleSession(db, 'member');
    const tokId = await seedInstanceToken(db, seed.user.id);

    const res = await app.request(`/api/v1/instance/tokens/${tokId}`, {
      method: 'DELETE',
      headers: { Cookie: memberCookie },
    });
    expect(res.status).toBe(403);

    // Nothing deleted.
    const row = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, tokId) });
    expect(row).toBeDefined();
  });

  test('a bearer cannot revoke (session-only)', async () => {
    const { app, db, seed } = await makeTestApp();
    await grantOwner(db, seed.user.email);
    const tokId = await seedInstanceToken(db, seed.user.id);

    // A valid instance bearer (no cookie) — the route mounts where attachToken
    // never runs, so it has no user → 401 (requireSessionUser).
    const { token, hash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: null,
      name: 'peer-bearer',
      tokenHash: hash,
      scopes: ['workspace:admin', 'documents:read'],
      createdBy: seed.user.id,
    });
    const res = await app.request(`/api/v1/instance/tokens/${tokId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect([401, 403]).toContain(res.status);

    // The target token survives — no bearer-driven revoke.
    const row = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, tokId) });
    expect(row).toBeDefined();
  });
});

describe('A12: GET /api/v1/instance/tokens (list instance tokens)', () => {
  test('a __system owner lists null-workspace tokens, excludes pinned, never leaks tokenHash', async () => {
    const { app, db, seed } = await makeTestApp();
    await grantOwner(db, seed.user.email);
    const instId = await seedInstanceToken(db, seed.user.id);
    const pinnedId = await seedPinnedToken(db, seed.workspace.id, seed.user.id);

    const res = await app.request('/api/v1/instance/tokens', {
      headers: { Cookie: seed.sessionCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { tokens: { id: string; tokenHash?: unknown }[] };
    };
    const ids = body.data.tokens.map((t) => t.id);
    // Instance token is listed; pinned token is excluded.
    expect(ids).toContain(instId);
    expect(ids).not.toContain(pinnedId);
    // tokenHash never leaves the serializer.
    for (const t of body.data.tokens) {
      expect('tokenHash' in t).toBe(false);
    }
  });

  test('a non-instance-admin (users.role member) cannot list (403)', async () => {
    const { app, db } = await makeTestApp();
    // A genuine non-admin: users.role 'member' (seed.user is the instance owner).
    const memberCookie = await seedRoleSession(db, 'member');
    const res = await app.request('/api/v1/instance/tokens', {
      headers: { Cookie: memberCookie },
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/v1/instance/tokens (mint an instance-reach token)', () => {
  test('an owner mints a reach=null token; plaintext returned once, row has workspaceId null', async () => {
    const { app, db, seed } = await makeTestApp();
    await grantOwner(db, seed.user.email);

    const res = await app.request('/api/v1/instance/tokens', {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'operator', scopes: ['documents:read', 'workspace:admin'] }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { id: string; token: string; instance: boolean; scopes: string[] };
    };
    expect(body.data.instance).toBe(true);
    expect(body.data.token).toBeTruthy(); // plaintext returned exactly once
    expect(body.data.scopes).toEqual(['documents:read', 'workspace:admin']);

    const row = await db.query.apiTokens.findFirst({
      where: eq(apiTokens.id, body.data.id),
    });
    expect(row).toBeDefined();
    expect(row!.workspaceId).toBeNull(); // instance reach, never pinned
    expect('token' in (row as object)).toBe(false); // only the hash is stored
  });

  // Task 1.3 seam: an instance mint carrying expires_in_days flows through the
  // real route → mintToken → DB, and the GET instance-list surfaces the non-null
  // expiry. The omit case (next test's tokens) would list expiresAt null.
  test('POST with expires_in_days → GET instance list shows a non-null expiresAt', async () => {
    const { app, seed } = await makeTestApp();
    // seed.user is already the instance owner (harness sets users.role = 'owner'),
    // which is what requireInstanceAdmin reads — no extra grant needed.
    const post = await app.request('/api/v1/instance/tokens', {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'expiring-inst', scopes: ['documents:read'], expires_in_days: 7 }),
    });
    expect(post.status).toBe(201);
    const created = (await post.json()) as { data: { id: string } };

    const list = await app.request('/api/v1/instance/tokens', {
      headers: { Cookie: seed.sessionCookie },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      data: { tokens: { id: string; expiresAt: string | null }[] };
    };
    const row = body.data.tokens.find((t) => t.id === created.data.id);
    expect(row).toBeDefined();
    expect(row!.expiresAt).not.toBeNull();
  });

  // Negative: NO expires_in_days → listed instance token has expiresAt null.
  test('POST without expires_in_days → GET instance list shows expiresAt null', async () => {
    const { app, seed } = await makeTestApp();
    const post = await app.request('/api/v1/instance/tokens', {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'forever-inst', scopes: ['documents:read'] }),
    });
    expect(post.status).toBe(201);
    const created = (await post.json()) as { data: { id: string } };

    const list = await app.request('/api/v1/instance/tokens', {
      headers: { Cookie: seed.sessionCookie },
    });
    const body = (await list.json()) as {
      data: { tokens: { id: string; expiresAt: string | null }[] };
    };
    const row = body.data.tokens.find((t) => t.id === created.data.id);
    expect(row).toBeDefined();
    expect(row!.expiresAt).toBeNull();
  });

  test('scope ceiling: an admin cannot mint a scope its role lacks (403)', async () => {
    // An 'admin' role whose roleToScopes does NOT include the owner-only scope is
    // refused — the mint can never exceed the caller's instance role.
    const { app, db } = await makeTestApp();
    const adminCookie = await seedRoleSession(db, 'admin');
    const res = await app.request('/api/v1/instance/tokens', {
      method: 'POST',
      headers: { Cookie: adminCookie, 'content-type': 'application/json' },
      // a deliberately bogus scope the role cannot grant
      body: JSON.stringify({ name: 'overreach', scopes: ['definitely:not-a-real-scope'] }),
    });
    expect(res.status).toBe(403);
    // Nothing minted.
    const rows = await db.query.apiTokens.findMany();
    expect(rows.every((r) => r.name !== 'overreach')).toBe(true);
  });

  test('a non-instance-admin (member) cannot mint (403)', async () => {
    const { app, db } = await makeTestApp();
    const memberCookie = await seedRoleSession(db, 'member');
    const res = await app.request('/api/v1/instance/tokens', {
      method: 'POST',
      headers: { Cookie: memberCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'nope', scopes: ['documents:read'] }),
    });
    expect(res.status).toBe(403);
  });

  test('a bearer cannot mint (session-only)', async () => {
    const { app, db, seed } = await makeTestApp();
    await grantOwner(db, seed.user.email);
    const { token, hash } = newApiToken();
    await db.insert(apiTokens).values({
      id: nanoid(),
      workspaceId: null,
      name: 'peer-bearer',
      tokenHash: hash,
      scopes: ['workspace:admin'],
      createdBy: seed.user.id,
    });
    const res = await app.request('/api/v1/instance/tokens', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'self-mint', scopes: ['documents:read'] }),
    });
    expect([401, 403]).toContain(res.status);
  });
});
