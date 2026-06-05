import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import * as schema from '../db/schema.ts';
import { createSession, newApiToken } from '../lib/auth.ts';
import { makeTestApp } from '../test/harness.ts';

/**
 * Task 12 — instance-user administration:
 *   PATCH /api/v1/instance/users/:id/role   OWNER-ONLY
 *   GET   /api/v1/instance/invite-targets    owner+admin (existence, not contents)
 *   GET   /api/v1/instance/users             owner+admin (roles for the Roles tab)
 *
 * Security boundaries under test:
 *  - Role change is OWNER-ONLY (requireInstanceOwner). The load-bearing escalation
 *    guard: an ADMIN must NOT be able to change roles (promote a member → admin or
 *    self → owner). A member is rejected too.
 *  - Last-owner guard: demoting the only instance owner is refused (409 LAST_OWNER),
 *    so the instance can never be left without an owner.
 *  - SESSION-only (mounted on v1, no attachToken): a stolen Bearer has no user at
 *    this mount → 401/403; it must never change a role or enumerate targets.
 *  - invite-targets returns ENUMERATION (names+ids) only — NO documents/body/
 *    content — and EXCLUDES the __system workspace (not an invite target).
 *  - GET /users returns id/email/name/role only — never password_hash.
 */

type DB = Awaited<ReturnType<typeof makeTestApp>>['db'];

/** Seed a fresh user with the given INSTANCE role; return id + session cookie. */
async function seedRoleSession(
  db: DB,
  role: 'owner' | 'admin' | 'member',
): Promise<{ userId: string; cookie: string }> {
  const userId = nanoid();
  await db.insert(schema.users).values({
    id: userId,
    email: `${userId}@test.local`,
    name: role,
    role,
  });
  const session = await createSession(userId);
  return { userId, cookie: `folio_session=${session.id}` };
}

/** Seed a fresh member user with no session (the role-change TARGET). */
async function seedUser(db: DB, role: 'owner' | 'admin' | 'member' = 'member'): Promise<string> {
  const userId = nanoid();
  await db.insert(schema.users).values({
    id: userId,
    email: `${userId}@test.local`,
    name: 'target',
    role,
  });
  return userId;
}

/** Seed a fresh workspace. Returns its id. */
async function seedWorkspace(db: DB, slug?: string): Promise<string> {
  const id = nanoid();
  await db.insert(schema.workspaces).values({ id, slug: slug ?? `ws-${id}`, name: 'WS' });
  return id;
}

/** Seed a fresh project in a workspace. Returns its id. */
async function seedProject(db: DB, workspaceId: string): Promise<string> {
  const id = nanoid();
  await db.insert(schema.projects).values({ id, workspaceId, slug: `proj-${id}`, name: 'Proj' });
  return id;
}

/** Seed an instance token (workspace_id null). Returns its plaintext value. */
async function seedInstanceToken(db: DB, createdBy: string): Promise<string> {
  const { token, hash } = newApiToken();
  await db.insert(schema.apiTokens).values({
    id: nanoid(),
    workspaceId: null,
    name: 'tok',
    tokenHash: hash,
    scopes: ['workspace:admin', 'documents:read'],
    createdBy,
  });
  return token;
}

async function roleOf(db: DB, userId: string): Promise<string | undefined> {
  const u = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  return u?.role;
}

describe('PATCH /api/v1/instance/users/:id/role — role change (owner-only)', () => {
  test('owner promotes a member → admin → 200, role updated', async () => {
    const { app, db, seed } = await makeTestApp();
    const target = await seedUser(db, 'member');

    const res = await app.request(`/api/v1/instance/users/${target}/role`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: seed.sessionCookie },
      body: JSON.stringify({ role: 'admin' }),
    });

    expect(res.status).toBe(200);
    expect(await roleOf(db, target)).toBe('admin');
  });

  test('ADMIN changing a role → 403 (requireInstanceOwner rejects admin) — escalation guard', async () => {
    const { app, db } = await makeTestApp();
    const admin = await seedRoleSession(db, 'admin');
    const target = await seedUser(db, 'member');

    const res = await app.request(`/api/v1/instance/users/${target}/role`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ role: 'admin' }),
    });

    expect(res.status).toBe(403);
    // The gate ran before any write — the target is untouched.
    expect(await roleOf(db, target)).toBe('member');
  });

  test('member changing a role → 403', async () => {
    const { app, db } = await makeTestApp();
    const member = await seedRoleSession(db, 'member');
    const target = await seedUser(db, 'member');

    const res = await app.request(`/api/v1/instance/users/${target}/role`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: member.cookie },
      body: JSON.stringify({ role: 'admin' }),
    });

    expect(res.status).toBe(403);
    expect(await roleOf(db, target)).toBe('member');
  });

  test('PATCH a non-existent user id → 404 USER_NOT_FOUND', async () => {
    const { app, db, seed } = await makeTestApp();
    const ghost = nanoid();

    const res = await app.request(`/api/v1/instance/users/${ghost}/role`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: seed.sessionCookie },
      body: JSON.stringify({ role: 'admin' }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('USER_NOT_FOUND');
  });

  test('invalid role value → 400 (Zod enum)', async () => {
    const { app, db, seed } = await makeTestApp();
    const target = await seedUser(db, 'member');

    const res = await app.request(`/api/v1/instance/users/${target}/role`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: seed.sessionCookie },
      body: JSON.stringify({ role: 'superadmin' }),
    });

    expect(res.status).toBe(400);
    expect(await roleOf(db, target)).toBe('member');
  });

  test('the only owner cannot demote themselves → 409 (self-demote guard), role unchanged', async () => {
    const { app, db, seed } = await makeTestApp();
    // seed.user is the only owner. Demoting the only owner is necessarily a
    // SELF-demotion (only an owner may demote, and there's no other owner to act),
    // so the self-demote guard fires first — a clearer message for the same
    // protection. The LAST_OWNER guard remains a defense-in-depth backstop.
    const res = await app.request(`/api/v1/instance/users/${seed.user.id}/role`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: seed.sessionCookie },
      body: JSON.stringify({ role: 'member' }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('CANNOT_SELF_DEMOTE');
    expect(await roleOf(db, seed.user.id)).toBe('owner');
  });

  test('a DIFFERENT owner can demote another owner (when >1 owner) → 200', async () => {
    const { app, db, seed } = await makeTestApp();
    // A second owner acts; they demote the FIRST owner (not themselves) → allowed.
    const other = await seedRoleSession(db, 'owner');

    const res = await app.request(`/api/v1/instance/users/${seed.user.id}/role`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: other.cookie },
      body: JSON.stringify({ role: 'member' }),
    });

    expect(res.status).toBe(200);
    expect(await roleOf(db, seed.user.id)).toBe('member');
  });

  test('self-demotion is REFUSED even with another owner present → 409 CANNOT_SELF_DEMOTE', async () => {
    const { app, db, seed } = await makeTestApp();
    // A second owner exists, so this is NOT the last-owner case — the refusal is
    // specifically the self-demotion guard, not LAST_OWNER.
    await seedUser(db, 'owner');

    const res = await app.request(`/api/v1/instance/users/${seed.user.id}/role`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: seed.sessionCookie },
      body: JSON.stringify({ role: 'member' }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('CANNOT_SELF_DEMOTE');
    expect(await roleOf(db, seed.user.id)).toBe('owner');
  });

  test('owner → owner (no-op same role) on the only owner is allowed → 200', async () => {
    // The guard only triggers when the NEW role is non-owner. Setting the only
    // owner back to 'owner' must not trip LAST_OWNER.
    const { app, db, seed } = await makeTestApp();

    const res = await app.request(`/api/v1/instance/users/${seed.user.id}/role`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: seed.sessionCookie },
      body: JSON.stringify({ role: 'owner' }),
    });

    expect(res.status).toBe(200);
    expect(await roleOf(db, seed.user.id)).toBe('owner');
  });

  test('a Bearer token (not session) → rejected (session-only)', async () => {
    const { app, db, seed } = await makeTestApp();
    const token = await seedInstanceToken(db, seed.user.id);
    const target = await seedUser(db, 'member');

    const res = await app.request(`/api/v1/instance/users/${target}/role`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ role: 'admin' }),
    });

    expect(res.status).not.toBe(200);
    expect([401, 403]).toContain(res.status);
    expect(await roleOf(db, target)).toBe('member');
  });
});

describe('GET /api/v1/instance/invite-targets — enumeration (owner+admin)', () => {
  test('owner: 200, lists all workspaces+projects (ids+names), no contents', async () => {
    const { app, db, seed } = await makeTestApp();
    const ws = await seedWorkspace(db);
    const proj = await seedProject(db, ws);

    const res = await app.request('/api/v1/instance/invite-targets', {
      headers: { cookie: seed.sessionCookie },
    });

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: {
        workspaces: Array<Record<string, unknown>>;
        projects: Array<Record<string, unknown>>;
      };
    };
    // The seeded ws + the harness's own 'acme' ws are both present.
    const wsIds = data.workspaces.map((w) => w.id);
    expect(wsIds).toContain(ws);
    expect(wsIds).toContain(seed.workspace.id);
    expect(data.projects.map((p) => p.id)).toContain(proj);

    // Enumeration shape only: id/slug/name (+ workspaceId on projects). NO
    // document/body/content fields leak.
    const w = data.workspaces.find((x) => x.id === ws);
    expect(w).toBeDefined();
    expect(Object.keys(w ?? {}).sort()).toEqual(['id', 'name', 'slug']);
    const p = data.projects.find((x) => x.id === proj);
    expect(p).toBeDefined();
    expect(Object.keys(p ?? {}).sort()).toEqual(['id', 'name', 'slug', 'workspaceId']);
    // Defensive: no contents leak on either shape.
    for (const row of [...data.workspaces, ...data.projects]) {
      expect(row).not.toHaveProperty('body');
      expect(row).not.toHaveProperty('documents');
      expect(row).not.toHaveProperty('frontmatter');
    }
  });

  test('admin CAN enumerate → 200 (existence-vs-contents: admin sees targets)', async () => {
    const { app, db } = await makeTestApp();
    const admin = await seedRoleSession(db, 'admin');
    const ws = await seedWorkspace(db);
    await seedProject(db, ws);

    const res = await app.request('/api/v1/instance/invite-targets', {
      headers: { cookie: admin.cookie },
    });

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { workspaces: Array<{ id: string }> } };
    expect(data.workspaces.map((w) => w.id)).toContain(ws);
  });

  test('EXCLUDES a reserved (__-prefixed) workspace', async () => {
    const { app, db, seed } = await makeTestApp();
    // A reserved-slug workspace + a project in it (the exclude is by slug prefix).
    const sysId = nanoid();
    await db
      .insert(schema.workspaces)
      .values({ id: sysId, slug: '__system', name: 'Reserved' });
    await db
      .insert(schema.projects)
      .values({ id: nanoid(), workspaceId: sysId, slug: 'skills', name: 'Skills' });

    const res = await app.request('/api/v1/instance/invite-targets', {
      headers: { cookie: seed.sessionCookie },
    });

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: {
        workspaces: Array<{ slug: string; id: string }>;
        projects: Array<{ workspaceId: string }>;
      };
    };
    // the reserved workspace must not appear…
    expect(data.workspaces.some((w) => w.slug === '__system')).toBe(false);
    // …nor must its projects leak via the projects list.
    expect(data.projects.some((p) => p.workspaceId === sysId)).toBe(false);
  });

  test('member → 403', async () => {
    const { app, db } = await makeTestApp();
    const member = await seedRoleSession(db, 'member');

    const res = await app.request('/api/v1/instance/invite-targets', {
      headers: { cookie: member.cookie },
    });

    expect(res.status).toBe(403);
  });

  test('a Bearer token → rejected (session-only)', async () => {
    const { app, db, seed } = await makeTestApp();
    const token = await seedInstanceToken(db, seed.user.id);

    const res = await app.request('/api/v1/instance/invite-targets', {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).not.toBe(200);
    expect([401, 403]).toContain(res.status);
  });
});

describe('GET /api/v1/instance/users — user+role list (owner+admin)', () => {
  test('owner: 200, lists users with roles, NEVER password_hash', async () => {
    const { app, db, seed } = await makeTestApp();
    const other = await seedUser(db, 'member');

    const res = await app.request('/api/v1/instance/users', {
      headers: { cookie: seed.sessionCookie },
    });

    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { users: Array<Record<string, unknown>> };
    };
    const ids = data.users.map((u) => u.id);
    expect(ids).toContain(seed.user.id);
    expect(ids).toContain(other);

    const me = data.users.find((u) => u.id === seed.user.id);
    expect(me).toBeDefined();
    expect(me?.role).toBe('owner');
    expect(Object.keys(me ?? {}).sort()).toEqual(['email', 'id', 'name', 'role']);
    // Never leak the password hash.
    for (const u of data.users) {
      expect(u).not.toHaveProperty('passwordHash');
      expect(u).not.toHaveProperty('password_hash');
    }
  });

  test('admin CAN list users → 200', async () => {
    const { app, db } = await makeTestApp();
    const admin = await seedRoleSession(db, 'admin');

    const res = await app.request('/api/v1/instance/users', {
      headers: { cookie: admin.cookie },
    });

    expect(res.status).toBe(200);
  });

  test('member → 403', async () => {
    const { app, db } = await makeTestApp();
    const member = await seedRoleSession(db, 'member');

    const res = await app.request('/api/v1/instance/users', {
      headers: { cookie: member.cookie },
    });

    expect(res.status).toBe(403);
  });

  test('a Bearer token → rejected (session-only)', async () => {
    const { app, db, seed } = await makeTestApp();
    const token = await seedInstanceToken(db, seed.user.id);

    const res = await app.request('/api/v1/instance/users', {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).not.toBe(200);
    expect([401, 403]).toContain(res.status);
  });
});

describe('POST /api/v1/instance/invites (admin invite by email)', () => {
  test('an owner invites by email → 200 + a magic link row is created for that email', async () => {
    const { app, db } = await makeTestApp();
    const { cookie } = await seedRoleSession(db, 'owner');

    const res = await app.request('/api/v1/instance/invites', {
      method: 'POST',
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'newhire@acme.test' }),
    });
    expect(res.status).toBe(200);

    // A magic link was minted for the invited email (consume will upsert them).
    const link = await db.query.magicLinks.findFirst({
      where: eq(schema.magicLinks.email, 'newhire@acme.test'),
    });
    expect(link).toBeDefined();
    // No user is created at invite time — only on consume.
    const user = await db.query.users.findFirst({
      where: eq(schema.users.email, 'newhire@acme.test'),
    });
    expect(user).toBeUndefined();
  });

  test('an admin may also invite (200)', async () => {
    const { app, db } = await makeTestApp();
    const { cookie } = await seedRoleSession(db, 'admin');
    const res = await app.request('/api/v1/instance/invites', {
      method: 'POST',
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'x@acme.test' }),
    });
    expect(res.status).toBe(200);
  });

  test('a member CANNOT invite (403) — no magic link minted', async () => {
    const { app, db } = await makeTestApp();
    const { cookie } = await seedRoleSession(db, 'member');
    const res = await app.request('/api/v1/instance/invites', {
      method: 'POST',
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nope@acme.test' }),
    });
    expect(res.status).toBe(403);
    const link = await db.query.magicLinks.findFirst({
      where: eq(schema.magicLinks.email, 'nope@acme.test'),
    });
    expect(link).toBeUndefined();
  });

  test('a bearer CANNOT invite (session-only)', async () => {
    const { app, db, seed } = await makeTestApp();
    const token = await seedInstanceToken(db, seed.user.id);
    const res = await app.request('/api/v1/instance/invites', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'bearer@acme.test' }),
    });
    expect([401, 403]).toContain(res.status);
  });

  test('a malformed email is rejected (400)', async () => {
    const { app, db } = await makeTestApp();
    const { cookie } = await seedRoleSession(db, 'owner');
    const res = await app.request('/api/v1/instance/invites', {
      method: 'POST',
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/v1/instance/users/:id (owner-only hard delete)', () => {
  /** Seed a page document authored by `userId` (exercises the created_by RESTRICT
   *  path). A `page` requires a non-null project_id per the documents CHECK. */
  async function seedDocument(
    db: DB,
    workspaceId: string,
    projectId: string,
    userId: string,
  ): Promise<string> {
    const id = nanoid();
    await db.insert(schema.documents).values({
      id,
      workspaceId,
      projectId,
      type: 'page',
      slug: `doc-${id}`,
      title: 'Authored',
      createdBy: userId,
      updatedBy: userId,
    });
    return id;
  }

  test('an owner deletes a member → 200, and sessions/grants/tokens are gone; authored docs survive (author nulled)', async () => {
    const { app, db, seed } = await makeTestApp();

    // A member with a session, a workspace grant, a minted token, and an authored doc.
    const { userId: victimId } = await seedRoleSession(db, 'member');
    const ws = await seedWorkspace(db);
    const proj = await seedProject(db, ws);
    await db.insert(schema.workspaceAccess).values({ userId: victimId, workspaceId: ws });
    await db.insert(schema.apiTokens).values({
      id: nanoid(), workspaceId: ws, name: 'victim-tok',
      tokenHash: newApiToken().hash, scopes: ['documents:read'], createdBy: victimId,
    });
    const docId = await seedDocument(db, ws, proj, victimId);

    const res = await app.request(`/api/v1/instance/users/${victimId}`, {
      method: 'DELETE',
      headers: { Cookie: seed.sessionCookie },
    });
    expect(res.status).toBe(200);

    // User gone.
    expect(await db.query.users.findFirst({ where: eq(schema.users.id, victimId) })).toBeUndefined();
    // Sessions + grants cascaded.
    expect(
      await db.query.authSessions.findFirst({ where: eq(schema.authSessions.userId, victimId) }),
    ).toBeUndefined();
    expect(
      await db.query.workspaceAccess.findFirst({ where: eq(schema.workspaceAccess.userId, victimId) }),
    ).toBeUndefined();
    // Tokens they minted are revoked (no orphan live credential).
    expect(
      await db.query.apiTokens.findFirst({ where: eq(schema.apiTokens.createdBy, victimId) }),
    ).toBeUndefined();
    // Authored document SURVIVES, author ref nulled.
    const doc = await db.query.documents.findFirst({ where: eq(schema.documents.id, docId) });
    expect(doc).toBeDefined();
    expect(doc!.createdBy).toBeNull();
    expect(doc!.updatedBy).toBeNull();
  });

  test('an admin CANNOT delete a user (owner-only, 403)', async () => {
    const { app, db } = await makeTestApp();
    const { cookie } = await seedRoleSession(db, 'admin');
    const victim = await seedUser(db, 'member');
    const res = await app.request(`/api/v1/instance/users/${victim}`, {
      method: 'DELETE', headers: { Cookie: cookie },
    });
    expect(res.status).toBe(403);
    expect(await db.query.users.findFirst({ where: eq(schema.users.id, victim) })).toBeDefined();
  });

  test('cannot delete YOURSELF (409 CANNOT_SELF_DELETE)', async () => {
    const { app, db, seed } = await makeTestApp();
    const res = await app.request(`/api/v1/instance/users/${seed.user.id}`, {
      method: 'DELETE', headers: { Cookie: seed.sessionCookie },
    });
    expect(res.status).toBe(409);
    expect(await db.query.users.findFirst({ where: eq(schema.users.id, seed.user.id) })).toBeDefined();
  });

  test('a second owner CAN be deleted (2→1 allowed); the last owner cannot (self-delete 409)', async () => {
    const { app, db, seed } = await makeTestApp();
    // seed.user is already the instance owner (makeTestApp seeds role=owner)
    const ownerB = await seedUser(db, 'owner'); // owner B (no session)

    // Deleting B while A remains is fine — owner count drops 2→1, never below 1.
    const okRes = await app.request(`/api/v1/instance/users/${ownerB}`, {
      method: 'DELETE',
      headers: { Cookie: seed.sessionCookie },
    });
    expect(okRes.status).toBe(200);
    expect(await db.query.users.findFirst({ where: eq(schema.users.id, ownerB) })).toBeUndefined();

    // Now A is the only owner. No path removes the last owner: A deleting A hits the
    // self-delete guard (409). (LAST_OWNER on delete is a defensive backstop — a
    // different actor can't reach it, since being a session owner makes the count
    // ≥2; self-delete is the reachable last-owner protection.)
    const selfRes = await app.request(`/api/v1/instance/users/${seed.user.id}`, {
      method: 'DELETE',
      headers: { Cookie: seed.sessionCookie },
    });
    expect(selfRes.status).toBe(409);
    expect(
      await db.query.users.findFirst({ where: eq(schema.users.id, seed.user.id) }),
    ).toBeDefined();
  });

  test('a bearer CANNOT delete a user (session-only)', async () => {
    const { app, db, seed } = await makeTestApp();
    const token = await seedInstanceToken(db, seed.user.id);
    const victim = await seedUser(db, 'member');
    const res = await app.request(`/api/v1/instance/users/${victim}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    });
    expect([401, 403]).toContain(res.status);
    expect(await db.query.users.findFirst({ where: eq(schema.users.id, victim) })).toBeDefined();
  });

  test('deleting a non-existent user → 404', async () => {
    const { app, db, seed } = await makeTestApp();
    const res = await app.request('/api/v1/instance/users/nonexistent-id', {
      method: 'DELETE', headers: { Cookie: seed.sessionCookie },
    });
    expect(res.status).toBe(404);
  });
});
