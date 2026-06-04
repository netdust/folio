import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import * as schema from '../db/schema.ts';
import { createSession, newApiToken } from '../lib/auth.ts';
import { bootstrapSystemWorkspace } from '../lib/system-workspace.ts';
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
    await bootstrapSystemWorkspace(db); // event scopes to __system
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
    await bootstrapSystemWorkspace(db);
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
    await bootstrapSystemWorkspace(db);
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
    await bootstrapSystemWorkspace(db);
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
    await bootstrapSystemWorkspace(db);
    const target = await seedUser(db, 'member');

    const res = await app.request(`/api/v1/instance/users/${target}/role`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: seed.sessionCookie },
      body: JSON.stringify({ role: 'superadmin' }),
    });

    expect(res.status).toBe(400);
    expect(await roleOf(db, target)).toBe('member');
  });

  test('last-owner guard: demoting the only owner → 409 LAST_OWNER, role unchanged', async () => {
    const { app, db, seed } = await makeTestApp();
    await bootstrapSystemWorkspace(db);
    // seed.user is the only owner (harness sets users.role='owner').
    const res = await app.request(`/api/v1/instance/users/${seed.user.id}/role`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: seed.sessionCookie },
      body: JSON.stringify({ role: 'member' }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('LAST_OWNER');
    expect(await roleOf(db, seed.user.id)).toBe('owner');
  });

  test('with a SECOND owner, the first owner CAN be demoted → 200', async () => {
    const { app, db, seed } = await makeTestApp();
    await bootstrapSystemWorkspace(db);
    // A second owner exists, so demoting the first leaves an owner.
    await seedUser(db, 'owner');

    const res = await app.request(`/api/v1/instance/users/${seed.user.id}/role`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: seed.sessionCookie },
      body: JSON.stringify({ role: 'member' }),
    });

    expect(res.status).toBe(200);
    expect(await roleOf(db, seed.user.id)).toBe('member');
  });

  test('owner → owner (no-op same role) on the only owner is allowed → 200', async () => {
    // The guard only triggers when the NEW role is non-owner. Setting the only
    // owner back to 'owner' must not trip LAST_OWNER.
    const { app, db, seed } = await makeTestApp();
    await bootstrapSystemWorkspace(db);

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
    await bootstrapSystemWorkspace(db);
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

  test('EXCLUDES the __system workspace', async () => {
    const { app, db, seed } = await makeTestApp();
    await bootstrapSystemWorkspace(db); // creates __system + its Skills/Reference projects

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
    // __system must not appear as a workspace…
    expect(data.workspaces.some((w) => w.slug === '__system')).toBe(false);
    // …nor must its projects (Skills/Reference) leak via the projects list.
    const systemWs = await db.query.workspaces.findFirst({
      where: eq(schema.workspaces.slug, '__system'),
    });
    expect(systemWs).toBeDefined();
    const systemWsId = systemWs?.id;
    expect(data.projects.some((p) => p.workspaceId === systemWsId)).toBe(false);
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
