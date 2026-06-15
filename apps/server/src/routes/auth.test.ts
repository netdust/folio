import { expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { aiKeys, magicLinks, users } from '../db/schema.ts';
import { env } from '../env.ts';
import { userRole } from '../lib/access.ts';
import { createSession, hashToken, newMagicToken } from '../lib/auth.ts';
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

test('GET /auth/me: ai_configured reflects instance AI-key presence (readable by ANY member)', async () => {
  const { app, db, seed } = await makeTestApp();
  // seed.user is a plain member; ai_configured must be readable by them (drives
  // the body editor's AI slash commands), even though the admin-gated key LIST
  // is not.
  const before = await app.request('/api/v1/auth/me', { headers: { cookie: seed.sessionCookie } });
  expect((await before.json()).data.ai_configured).toBe(false);

  // Add an INSTANCE key (no workspace tie).
  await db.insert(aiKeys).values({
    id: 'k-1',
    provider: 'ollama',
    label: 'default',
    encryptedKey: 'x',
  });

  const after = await app.request('/api/v1/auth/me', { headers: { cookie: seed.sessionCookie } });
  expect((await after.json()).data.ai_configured).toBe(true);
});

// --- Magic-link account-creation gate (M1, audit H5) ---
// Self-service sign-in (kind:'signin') only AUTHENTICATES an existing user; it
// must NEVER mint a principal for a stranger. Only an admin-issued invite
// (kind:'invite') may create a new member. The request path is silenced for
// strangers (no row, no mail) so it can't be used to flood or enumerate.

// Mint a magic_links row directly with a known plaintext token (consume reads by
// token hash; the request path never exposes the plaintext token to the caller).
async function seedMagicLink(
  db: Awaited<ReturnType<typeof makeBareTestDb>>['db'],
  email: string,
  kind: 'signin' | 'invite',
): Promise<string> {
  const token = newMagicToken();
  await db.insert(magicLinks).values({
    id: nanoid(),
    email,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + 1000 * 60 * 15),
    kind,
  });
  return token;
}

test('consume of a signin link for a NON-existent email creates no user and redirects (M1/H5)', async () => {
  const { app, db } = await makeBareTestDb();
  const token = await seedMagicLink(db, 'stranger@x.com', 'signin');

  const res = await app.request(`/api/v1/auth/magic-link/consume?token=${token}`, {
    redirect: 'manual',
  });
  // Same generic outcome as a real sign-in: a 302 redirect, no principal minted.
  expect(res.status).toBe(302);
  const created = await db.query.users.findFirst({ where: eq(users.email, 'stranger@x.com') });
  expect(created).toBeUndefined();
  // No session cookie issued (no principal).
  expect(res.headers.get('set-cookie')).toBeNull();
  // The single-use link is still burned.
  const link = await db.query.magicLinks.findFirst({
    where: eq(magicLinks.tokenHash, hashToken(token)),
  });
  expect(link?.usedAt).not.toBeNull();
});

test('consume of an INVITE link DOES create the user as member, redirects, sets session (M1/H5)', async () => {
  const { app, db } = await makeBareTestDb();
  const token = await seedMagicLink(db, 'invitee@x.com', 'invite');

  const res = await app.request(`/api/v1/auth/magic-link/consume?token=${token}`, {
    redirect: 'manual',
  });
  expect(res.status).toBe(302);
  const created = await db.query.users.findFirst({ where: eq(users.email, 'invitee@x.com') });
  expect(created).toBeDefined();
  // A newly created member, never an admin/owner (instance role default).
  expect(await userRole(db, created!.id)).toBe('member');
  // Session cookie issued for the new principal.
  expect(res.headers.get('set-cookie')).toContain('folio_session=');
});

test('existing user + signin link still signs in: 302 + session cookie (M1/H5)', async () => {
  const { app, db, seed } = await makeTestApp();
  const token = await seedMagicLink(db, seed.user.email, 'signin');

  const res = await app.request(`/api/v1/auth/magic-link/consume?token=${token}`, {
    redirect: 'manual',
  });
  expect(res.status).toBe(302);
  expect(res.headers.get('set-cookie')).toContain('folio_session=');
});

test('request for a NON-existent email is silenced: 200, no magic_links row persisted (M1/H5)', async () => {
  const { app, db } = await makeBareTestDb();

  const res = await app.request('/api/v1/auth/magic-link/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'stranger@x.com' }),
  });
  // Generic 200 — indistinguishable from a real user (no enumeration).
  expect(res.status).toBe(200);
  expect((await res.json()).data.ok).toBe(true);
  // The durable signal: nothing was minted (no flooding, no link to consume).
  const rows = await db.select().from(magicLinks).where(eq(magicLinks.email, 'stranger@x.com'));
  expect(rows).toHaveLength(0);
});

test('request for an EXISTING user persists a signin link (M1/H5)', async () => {
  const { app, db, seed } = await makeTestApp();

  const res = await app.request('/api/v1/auth/magic-link/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: seed.user.email }),
  });
  expect(res.status).toBe(200);
  const rows = await db.select().from(magicLinks).where(eq(magicLinks.email, seed.user.email));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.kind).toBe('signin');
});
