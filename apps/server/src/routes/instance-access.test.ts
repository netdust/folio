import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import * as schema from '../db/schema.ts';
import { createSession, newApiToken } from '../lib/auth.ts';
import { SYSTEM_WORKSPACE_SLUG } from '../lib/system-workspace.ts';
import { makeTestApp } from '../test/harness.ts';

/**
 * Task 11 (T-B) — invitation routes: POST/DELETE /api/v1/instance/access.
 *
 * These grant/revoke explicit workspace_access / project_access rows (the
 * post-tenancy access model: one instance = one team; reaching a specific
 * workspace/project is an explicit grant, not implied by membership).
 *
 * The security boundary under test:
 *  - SESSION-only (mounted on v1, no attachToken): a stolen Bearer must NOT be
 *    able to grant itself or anyone access. A token request has no user at this
 *    mount → 401.
 *  - owner+admin may invite (requireInstanceAdmin); a member is rejected (403).
 *  - exactly one of workspaceId|projectId (Zod refine) → 400 for both/neither.
 *  - FK-validate every referent (user, workspace, project must EXIST) → 404,
 *    and assert NO dangling row is inserted.
 *  - grant is idempotent (onConflictDoNothing): re-granting is a no-op 201.
 *  - revoke removes the row; revoking a missing grant is a no-op.
 */

type DB = Awaited<ReturnType<typeof makeTestApp>>['db'];

/** Seed a fresh user with the given INSTANCE role; return their session cookie. */
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

/** Seed a fresh user with no session (the grant TARGET). */
async function seedUser(db: DB): Promise<string> {
  const userId = nanoid();
  await db.insert(schema.users).values({
    id: userId,
    email: `${userId}@test.local`,
    name: 'target',
    role: 'member',
  });
  return userId;
}

/** Seed a fresh workspace. Returns its id. */
async function seedWorkspace(db: DB): Promise<string> {
  const id = nanoid();
  await db.insert(schema.workspaces).values({ id, slug: `ws-${id}`, name: 'WS' });
  return id;
}

/** Seed a fresh project in a workspace. Returns its id. */
async function seedProject(db: DB, workspaceId: string): Promise<string> {
  const id = nanoid();
  await db
    .insert(schema.projects)
    .values({ id, workspaceId, slug: `proj-${id}`, name: 'Proj' });
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

async function wsAccessCount(db: DB, userId: string, workspaceId: string) {
  const rows = await db
    .select()
    .from(schema.workspaceAccess)
    .where(
      and(
        eq(schema.workspaceAccess.userId, userId),
        eq(schema.workspaceAccess.workspaceId, workspaceId),
      ),
    );
  return rows.length;
}

async function projAccessCount(db: DB, userId: string, projectId: string) {
  const rows = await db
    .select()
    .from(schema.projectAccess)
    .where(
      and(
        eq(schema.projectAccess.userId, userId),
        eq(schema.projectAccess.projectId, projectId),
      ),
    );
  return rows.length;
}

describe('POST /api/v1/instance/access — grant', () => {
  test('owner grants workspace access to a member → 201, row exists', async () => {
    const { app, db, seed } = await makeTestApp();
    const target = await seedUser(db);
    const ws = await seedWorkspace(db);

    const res = await app.request('/api/v1/instance/access', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: seed.sessionCookie },
      body: JSON.stringify({ userId: target, workspaceId: ws }),
    });

    expect(res.status).toBe(201);
    expect(await wsAccessCount(db, target, ws)).toBe(1);
  });

  test('admin grants project access → 201 (admin CAN invite)', async () => {
    const { app, db } = await makeTestApp();
    const admin = await seedRoleSession(db, 'admin');
    const target = await seedUser(db);
    const ws = await seedWorkspace(db);
    const proj = await seedProject(db, ws);

    const res = await app.request('/api/v1/instance/access', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ userId: target, projectId: proj }),
    });

    expect(res.status).toBe(201);
    expect(await projAccessCount(db, target, proj)).toBe(1);
  });

  test('a member calling grant → 403 (requireInstanceAdmin throws)', async () => {
    const { app, db } = await makeTestApp();
    const member = await seedRoleSession(db, 'member');
    const target = await seedUser(db);
    const ws = await seedWorkspace(db);

    const res = await app.request('/api/v1/instance/access', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: member.cookie },
      body: JSON.stringify({ userId: target, workspaceId: ws }),
    });

    expect(res.status).toBe(403);
    expect(await wsAccessCount(db, target, ws)).toBe(0);
  });

  test('a Bearer token (not session) calling grant → rejected (no session)', async () => {
    const { app, db, seed } = await makeTestApp();
    const token = await seedInstanceToken(db, seed.user.id);
    const target = await seedUser(db);
    const ws = await seedWorkspace(db);

    const res = await app.request('/api/v1/instance/access', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ userId: target, workspaceId: ws }),
    });

    // Mounted on v1 (no attachToken) → no user → 401. Must NOT succeed.
    expect(res.status).not.toBe(201);
    expect([401, 403]).toContain(res.status);
    expect(await wsAccessCount(db, target, ws)).toBe(0);
  });

  test('grant with BOTH workspaceId and projectId → 400 (Zod refine)', async () => {
    const { app, db, seed } = await makeTestApp();
    const target = await seedUser(db);
    const ws = await seedWorkspace(db);
    const proj = await seedProject(db, ws);

    const res = await app.request('/api/v1/instance/access', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: seed.sessionCookie },
      body: JSON.stringify({ userId: target, workspaceId: ws, projectId: proj }),
    });

    expect(res.status).toBe(400);
    expect(await wsAccessCount(db, target, ws)).toBe(0);
    expect(await projAccessCount(db, target, proj)).toBe(0);
  });

  test('grant with NEITHER workspaceId nor projectId → 400 (Zod refine)', async () => {
    const { app, db, seed } = await makeTestApp();
    const target = await seedUser(db);

    const res = await app.request('/api/v1/instance/access', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: seed.sessionCookie },
      body: JSON.stringify({ userId: target }),
    });

    expect(res.status).toBe(400);
  });

  test('grant referencing a non-existent user → 404, no row inserted', async () => {
    const { app, db, seed } = await makeTestApp();
    const ws = await seedWorkspace(db);
    const ghost = nanoid();

    const res = await app.request('/api/v1/instance/access', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: seed.sessionCookie },
      body: JSON.stringify({ userId: ghost, workspaceId: ws }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('USER_NOT_FOUND');
    expect(await wsAccessCount(db, ghost, ws)).toBe(0);
  });

  test('grant referencing a non-existent workspace → 404, no row inserted', async () => {
    const { app, db, seed } = await makeTestApp();
    const target = await seedUser(db);
    const ghostWs = nanoid();

    const res = await app.request('/api/v1/instance/access', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: seed.sessionCookie },
      body: JSON.stringify({ userId: target, workspaceId: ghostWs }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('WORKSPACE_NOT_FOUND');
    expect(await wsAccessCount(db, target, ghostWs)).toBe(0);
  });

  test('grant referencing a non-existent project → 404, no row inserted', async () => {
    const { app, db, seed } = await makeTestApp();
    const target = await seedUser(db);
    const ghostProj = nanoid();

    const res = await app.request('/api/v1/instance/access', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: seed.sessionCookie },
      body: JSON.stringify({ userId: target, projectId: ghostProj }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PROJECT_NOT_FOUND');
    expect(await projAccessCount(db, target, ghostProj)).toBe(0);
  });

  // CR-11 defense-in-depth: the __system library workspace must NOT be a grant
  // target. The invite-target PICKER already excludes it, but a direct
  // grant-by-id bypassed the picker — and a __system project_access grant lets a
  // plain member traverse into ?workspace=__system and (pre-CR-8) receive
  // instance role-change events. CR-8 stops the leak; this blocks the grant
  // itself so the reserved library can't be invited into at all.
  test('grant to a reserved (__-prefixed) workspace → rejected (not a grant target)', async () => {
    const { app, db, seed } = await makeTestApp();
    const target = await seedUser(db);
    // A reserved-slug workspace (the guard is by slug prefix, isReservedSlug).
    const sysId = nanoid();
    await db
      .insert(schema.workspaces)
      .values({ id: sysId, slug: SYSTEM_WORKSPACE_SLUG, name: 'Reserved' });

    const res = await app.request('/api/v1/instance/access', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: seed.sessionCookie },
      body: JSON.stringify({ userId: target, workspaceId: sysId }),
    });

    expect(res.status).toBe(403);
    expect(await wsAccessCount(db, target, sysId)).toBe(0);
  });

  test('grant to a project IN a reserved workspace → rejected (not a grant target)', async () => {
    const { app, db, seed } = await makeTestApp();
    const target = await seedUser(db);
    const sysId = nanoid();
    await db
      .insert(schema.workspaces)
      .values({ id: sysId, slug: SYSTEM_WORKSPACE_SLUG, name: 'Reserved' });
    const sys = { id: sysId };
    // A project inside the reserved workspace.
    const sysProj = nanoid();
    await db
      .insert(schema.projects)
      .values({ id: sysProj, workspaceId: sys!.id, slug: 'sys-proj', name: 'Sys' });

    const res = await app.request('/api/v1/instance/access', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: seed.sessionCookie },
      body: JSON.stringify({ userId: target, projectId: sysProj }),
    });

    expect(res.status).toBe(403);
    expect(await projAccessCount(db, target, sysProj)).toBe(0);
  });

  test('re-granting an existing workspace grant is idempotent → 201, still one row', async () => {
    const { app, db, seed } = await makeTestApp();
    const target = await seedUser(db);
    const ws = await seedWorkspace(db);

    const first = await app.request('/api/v1/instance/access', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: seed.sessionCookie },
      body: JSON.stringify({ userId: target, workspaceId: ws }),
    });
    expect(first.status).toBe(201);

    const second = await app.request('/api/v1/instance/access', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: seed.sessionCookie },
      body: JSON.stringify({ userId: target, workspaceId: ws }),
    });
    expect(second.status).toBe(201);
    expect(await wsAccessCount(db, target, ws)).toBe(1);
  });
});

describe('DELETE /api/v1/instance/access — revoke', () => {
  test('owner revokes an existing workspace grant → 200, row gone', async () => {
    const { app, db, seed } = await makeTestApp();
    const target = await seedUser(db);
    const ws = await seedWorkspace(db);
    await db.insert(schema.workspaceAccess).values({ userId: target, workspaceId: ws });
    expect(await wsAccessCount(db, target, ws)).toBe(1);

    const res = await app.request('/api/v1/instance/access', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', cookie: seed.sessionCookie },
      body: JSON.stringify({ userId: target, workspaceId: ws }),
    });

    expect(res.status).toBe(200);
    expect(await wsAccessCount(db, target, ws)).toBe(0);
  });

  test('admin revokes a project grant → 200, row gone', async () => {
    const { app, db } = await makeTestApp();
    const admin = await seedRoleSession(db, 'admin');
    const target = await seedUser(db);
    const ws = await seedWorkspace(db);
    const proj = await seedProject(db, ws);
    await db.insert(schema.projectAccess).values({ userId: target, projectId: proj });

    const res = await app.request('/api/v1/instance/access', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', cookie: admin.cookie },
      body: JSON.stringify({ userId: target, projectId: proj }),
    });

    expect(res.status).toBe(200);
    expect(await projAccessCount(db, target, proj)).toBe(0);
  });

  test('revoking a non-existent grant is a no-op → 200', async () => {
    const { app, db, seed } = await makeTestApp();
    const target = await seedUser(db);
    const ws = await seedWorkspace(db);

    const res = await app.request('/api/v1/instance/access', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', cookie: seed.sessionCookie },
      body: JSON.stringify({ userId: target, workspaceId: ws }),
    });

    expect(res.status).toBe(200);
  });

  test('a member calling revoke → 403', async () => {
    const { app, db } = await makeTestApp();
    const member = await seedRoleSession(db, 'member');
    const target = await seedUser(db);
    const ws = await seedWorkspace(db);
    await db.insert(schema.workspaceAccess).values({ userId: target, workspaceId: ws });

    const res = await app.request('/api/v1/instance/access', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', cookie: member.cookie },
      body: JSON.stringify({ userId: target, workspaceId: ws }),
    });

    expect(res.status).toBe(403);
    // The gate ran before any delete — the grant survives.
    expect(await wsAccessCount(db, target, ws)).toBe(1);
  });

  test('a Bearer token calling revoke → rejected (no session)', async () => {
    const { app, db, seed } = await makeTestApp();
    const token = await seedInstanceToken(db, seed.user.id);
    const target = await seedUser(db);
    const ws = await seedWorkspace(db);
    await db.insert(schema.workspaceAccess).values({ userId: target, workspaceId: ws });

    const res = await app.request('/api/v1/instance/access', {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ userId: target, workspaceId: ws }),
    });

    expect(res.status).not.toBe(200);
    expect([401, 403]).toContain(res.status);
    expect(await wsAccessCount(db, target, ws)).toBe(1);
  });
});
