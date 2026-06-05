import { eq } from 'drizzle-orm';
import { expect, test } from 'bun:test';
import { nanoid } from 'nanoid';
import { users } from '../db/schema.ts';
import { env } from '../env.ts';
import { userRole } from '../lib/access.ts';
import { createSession } from '../lib/auth.ts';
import { makeBareTestDb, makeTestApp } from '../test/harness.ts';

test('first registration is rejected when bootstrap registration is off (M1)', async () => {
  const { app, db } = await makeBareTestDb(); // zero users, flag default false
  const res = await app.request('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'first@x.com', password: 'password123', name: 'First' }),
  });
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('REGISTRATION_CLOSED');
  // the user must NOT have been created
  const created = await db.query.users.findFirst({ where: eq(users.email, 'first@x.com') });
  expect(created).toBeUndefined();
});

test('first registration becomes instance owner (users.role) when the flag is on (M1)', async () => {
  const { app, db } = await makeBareTestDb();
  const prev = env.FOLIO_ALLOW_BOOTSTRAP_REGISTRATION;
  (env as { FOLIO_ALLOW_BOOTSTRAP_REGISTRATION: boolean }).FOLIO_ALLOW_BOOTSTRAP_REGISTRATION =
    true;
  try {
    const res = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'first@x.com', password: 'password123', name: 'First' }),
    });
    expect(res.status).toBe(200);
    const firstUser = await db.query.users.findFirst({ where: eq(users.email, 'first@x.com') });
    expect(firstUser).toBeDefined();
    // The first registrant must be the instance owner + ADMINISTRABLE — users.role
    // is the instance-admin gates' source of truth (single-team model: no __system
    // membership, the role lives on the user row).
    expect(await userRole(db, firstUser!.id)).toBe('owner');
  } finally {
    (env as { FOLIO_ALLOW_BOOTSTRAP_REGISTRATION: boolean }).FOLIO_ALLOW_BOOTSTRAP_REGISTRATION =
      prev;
  }
});

test('a SECOND registration never grants instance ownership (M1)', async () => {
  const { app, db } = await makeBareTestDb();
  const prev = env.FOLIO_ALLOW_BOOTSTRAP_REGISTRATION;
  (env as { FOLIO_ALLOW_BOOTSTRAP_REGISTRATION: boolean }).FOLIO_ALLOW_BOOTSTRAP_REGISTRATION =
    true;
  try {
    await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'first@x.com', password: 'password123', name: 'First' }),
    });
    const second = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'second@x.com', password: 'password123', name: 'Second' }),
    });
    expect(second.status).toBe(200);
    const firstUser = await db.query.users.findFirst({ where: eq(users.email, 'first@x.com') });
    const secondUser = await db.query.users.findFirst({ where: eq(users.email, 'second@x.com') });
    // exactly one owner, and it is the FIRST user — not the second.
    const owners = await db.query.users.findMany({ where: eq(users.role, 'owner') });
    expect(owners.length).toBe(1);
    expect(owners[0]!.id).toBe(firstUser!.id);
    expect(await userRole(db, secondUser!.id)).toBe('member');
  } finally {
    (env as { FOLIO_ALLOW_BOOTSTRAP_REGISTRATION: boolean }).FOLIO_ALLOW_BOOTSTRAP_REGISTRATION =
      prev;
  }
});

test('first registration that SUCCEEDS persists the user + one owner; rollback-on-throw is the inverse', async () => {
  // The compensating delete (auth.ts) removes the just-created user if designate
  // throws, so a mid-failure can't leave an orphaned user that permanently flips
  // isFirstUser=false + EMAIL_TAKEN. We assert the SUCCESS-path invariant here
  // (user persists, one owner); the designation-throw cases (owner conflict) are
  // unit-tested in system-workspace.test.ts.
  const { app, db } = await makeBareTestDb();
  const prev = env.FOLIO_ALLOW_BOOTSTRAP_REGISTRATION;
  (env as { FOLIO_ALLOW_BOOTSTRAP_REGISTRATION: boolean }).FOLIO_ALLOW_BOOTSTRAP_REGISTRATION =
    true;
  try {
    const ok = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'first@x.com', password: 'password123', name: 'First' }),
    });
    expect(ok.status).toBe(200);
    const user = await db.query.users.findFirst({ where: eq(users.email, 'first@x.com') });
    expect(user).toBeDefined(); // persisted on success (rollback only on throw)
    const owners = await db.query.users.findMany({ where: eq(users.role, 'owner') });
    expect(owners.length).toBe(1);
  } finally {
    (env as { FOLIO_ALLOW_BOOTSTRAP_REGISTRATION: boolean }).FOLIO_ALLOW_BOOTSTRAP_REGISTRATION =
      prev;
  }
});

// --- Post-tenancy: instance role signals on /auth/me ---
// One instance = one team; roles live on users.role. /me surfaces the caller's
// instance role + a derived is_instance_admin so the web boots its identity
// without re-deriving authority client-side.

test('GET /auth/me reports role + is_instance_admin: true for an instance owner', async () => {
  const { app, seed } = await makeTestApp();
  // The harness seeds the user with users.role = 'owner'.
  const res = await app.request('/api/v1/auth/me', {
    headers: { cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const { data } = await res.json();
  expect(data.user.id).toBe(seed.user.id);
  expect(data.role).toBe('owner');
  expect(data.is_instance_admin).toBe(true);
});

test('GET /auth/me reports role: member + is_instance_admin: false for a member', async () => {
  const { app, db } = await makeTestApp();
  // A fresh user whose instance role is the default 'member'.
  const memberId = nanoid();
  await db.insert(users).values({
    id: memberId,
    email: `${memberId}@test.local`,
    name: 'Member',
    role: 'member',
  });
  const session = await createSession(memberId);

  const res = await app.request('/api/v1/auth/me', {
    headers: { cookie: `folio_session=${session.id}` },
  });
  expect(res.status).toBe(200);
  const { data } = await res.json();
  expect(data.user.id).toBe(memberId);
  expect(data.role).toBe('member');
  expect(data.is_instance_admin).toBe(false);
});

test('GET /auth/me reports is_instance_admin: true for an instance admin', async () => {
  const { app, db } = await makeTestApp();
  // role 'admin' is also an instance admin (owner || admin).
  const adminId = nanoid();
  await db.insert(users).values({
    id: adminId,
    email: `${adminId}@test.local`,
    name: 'Admin',
    role: 'admin',
  });
  const session = await createSession(adminId);

  const res = await app.request('/api/v1/auth/me', {
    headers: { cookie: `folio_session=${session.id}` },
  });
  expect(res.status).toBe(200);
  const { data } = await res.json();
  expect(data.role).toBe('admin');
  expect(data.is_instance_admin).toBe(true);
});
