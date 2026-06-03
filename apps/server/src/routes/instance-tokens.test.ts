import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { apiTokens } from '../db/schema.ts';
import { newApiToken } from '../lib/auth.ts';
import { bootstrapSystemWorkspace, grantOwner } from '../lib/system-workspace.ts';
import { makeTestApp } from '../test/harness.ts';

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
    await bootstrapSystemWorkspace(db);
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
    await bootstrapSystemWorkspace(db);
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

  test('a non-__system user cannot revoke (403)', async () => {
    const { app, db, seed } = await makeTestApp();
    await bootstrapSystemWorkspace(db);
    // seed.user is NOT made a __system member (no grantOwner).
    const tokId = await seedInstanceToken(db, seed.user.id);

    const res = await app.request(`/api/v1/instance/tokens/${tokId}`, {
      method: 'DELETE',
      headers: { Cookie: seed.sessionCookie },
    });
    expect(res.status).toBe(403);

    // Nothing deleted.
    const row = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, tokId) });
    expect(row).toBeDefined();
  });

  test('a bearer cannot revoke (session-only)', async () => {
    const { app, db, seed } = await makeTestApp();
    await bootstrapSystemWorkspace(db);
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
    await bootstrapSystemWorkspace(db);
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

  test('a non-__system user cannot list (403)', async () => {
    const { app, db, seed } = await makeTestApp();
    await bootstrapSystemWorkspace(db);
    // No grantOwner — alice is not a __system member.
    const res = await app.request('/api/v1/instance/tokens', {
      headers: { Cookie: seed.sessionCookie },
    });
    expect(res.status).toBe(403);
  });
});
