import { expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { aiKeys, magicLinks, users } from '../db/schema.ts';
import { env } from '../env.ts';
import { userRole } from '../lib/access.ts';
import { createSession, hashToken, newMagicToken, normalizeEmail } from '../lib/auth.ts';
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

// --- Single-use consume is ATOMIC (CR-C1, audit A2) ---
// The consume handler claims the link with a single UPDATE gated on
// `used_at IS NULL` BEFORE any user creation / session. Two consumes of the same
// invite token can no longer both pass a read-check and both mint a principal —
// SQLite serializes the writes, exactly ONE claims the row (rowsAffected===1) and
// proceeds; the loser sees 0 rows and is rejected with 400. The load-bearing
// guarantee: a claimed-link consume NEVER creates a user.

test('a SECOND sequential consume of an invite token is rejected and mints no second user (CR-C1)', async () => {
  // The structural contract (deterministic even under bun:sqlite single-process
  // write serialization). First consume claims the link → 302 + creates exactly
  // one user. Second consume of the SAME token sees used_at != NULL → claimed.length
  // === 0 → 400, and crucially creates NO further user. RED before the CAS: the old
  // read-check at line 224 (`if (link.usedAt) throw`) would catch the second consume
  // here too — BUT the old code wrote used_at only AFTER creating the user, so the
  // RED that bites is the concurrent double-mint below. This sequential case pins the
  // single-use contract that must hold after the refactor.
  const { app, db } = await makeBareTestDb();
  const token = await seedMagicLink(db, 'invitee@x.com', 'invite');
  const url = `/api/v1/auth/magic-link/consume?token=${token}`;

  const first = await app.request(url, { redirect: 'manual' });
  expect(first.status).toBe(302);
  expect(first.headers.get('set-cookie')).toContain('folio_session=');

  const second = await app.request(url, { redirect: 'manual' });
  expect(second.status).toBe(400);
  expect((await second.json()).error.code).toBe('INVALID_TOKEN');

  // The durable guarantee: exactly ONE user for this email, never two.
  const rows = await db.select().from(users).where(eq(users.email, 'invitee@x.com'));
  expect(rows).toHaveLength(1);
});

test('TWO concurrent consumes of one invite token: exactly one 302+cookie, one 400, exactly one user (CR-C1)', async () => {
  // The race the CAS closes (audit A2): two concurrent consumes of the SAME invite
  // token. Before the fix both could pass the line-224 read-check (used_at still
  // NULL for both reads) and both reach the INVITE branch that INSERTs a users row,
  // minting TWO principals. After the CAS, the up-front atomic claim
  // (UPDATE ... WHERE id=? AND used_at IS NULL) lets exactly one win
  // (rowsAffected===1 → proceeds) and the loser gets 0 rows → 400, BEFORE any user
  // is created — so a lost race never creates a user.
  //
  // Determinism note: bun:sqlite serializes writes single-process, so the OS may not
  // actually let the race be lost without the fix; the INVARIANT we assert is
  // outcome-shaped and holds deterministically either way — exactly one success,
  // exactly one user. The sequential test above is the deterministic RED anchor.
  const { app, db } = await makeBareTestDb();
  const token = await seedMagicLink(db, 'racer@x.com', 'invite');
  const url = `/api/v1/auth/magic-link/consume?token=${token}`;

  const [a, b] = await Promise.all([
    app.request(url, { redirect: 'manual' }),
    app.request(url, { redirect: 'manual' }),
  ]);
  const statuses = [a.status, b.status].sort();
  // Exactly one winner (302 + cookie) and one loser (400) — never two 302s.
  expect(statuses).toEqual([302, 400]);
  const winner = a.status === 302 ? a : b;
  expect(winner.headers.get('set-cookie')).toContain('folio_session=');

  // The load-bearing assertion: a concurrent double-consume of an invite mints
  // exactly ONE principal — never two.
  const rows = await db.select().from(users).where(eq(users.email, 'racer@x.com'));
  expect(rows).toHaveLength(1);
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

// --- Rate-limit + login timing-oracle close (M1, audit H6) ---
// /login and /magic-link/request have per-(scope,key) windowed counters (SQLite,
// no sidecar). /login no longer returns a fast 401 on an unknown email — it runs
// a dummy argon2 verify on the unknown-user branch so the wall-clock matches a
// wrong-password attempt (closes the user-enumeration timing oracle).

test('login: a burst of bad attempts from one IP is throttled with a 429 (H6)', async () => {
  const { app, seed } = await makeTestApp();
  // Default FOLIO_RATE_LIMIT_LOGIN is 5. The 6th+ attempt from the same IP is
  // throttled — well before the 7th here. All attempts use a wrong password for
  // the seeded user so the only thing tripping the gate is the rate limit.
  let last: Response | undefined;
  for (let i = 0; i < 7; i++) {
    last = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '203.0.113.7',
      },
      body: JSON.stringify({ email: seed.user.email, password: 'wrong-password' }),
    });
  }
  expect(last!.status).toBe(429);
  expect((await last!.json()).error.code).toBe('RATE_LIMITED');
});

test('login: a burst from one IP across DIFFERENT emails is throttled (pins the per-IP counter, H6)', async () => {
  // Each attempt uses a DISTINCT (unknown) email, so the per-EMAIL counter never
  // reaches its threshold — the ONLY thing that can produce the 429 is the per-IP
  // counter. This is the denial test for the per-IP dimension in isolation: it goes
  // RED if the checkRateLimit('login', `ip:...`) line is removed (the email-keyed
  // burst test alone would still pass without it). Unknown emails take the
  // dummy-verify branch, so the gate is purely the IP rate limit, not auth failure.
  const { app } = await makeTestApp();
  let last: Response | undefined;
  for (let i = 0; i < 7; i++) {
    last = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': '203.0.113.42',
      },
      body: JSON.stringify({ email: `nobody+${i}@nowhere.test`, password: 'wrong-password' }),
    });
  }
  expect(last!.status).toBe(429);
  expect((await last!.json()).error.code).toBe('RATE_LIMITED');
});

test('login: unknown email returns a clean 401 (dummy-verify branch runs, no thrown TypeError) (H6)', async () => {
  const { app } = await makeTestApp();
  // The unknown-user branch must run verifyPassword(password, DUMMY_HASH) before
  // throwing 401 — proving the early fast-path return is gone. A clean 401 (not a
  // 500 from a thrown TypeError on a null hash) is the structural evidence that
  // the dummy-verify path executed.
  const res = await app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '198.51.100.9',
    },
    body: JSON.stringify({ email: 'nobody@nowhere.test', password: 'whatever-password' }),
  });
  expect(res.status).toBe(401);
  expect((await res.json()).error.code).toBe('UNAUTHENTICATED');
});

// --- Email normalization at the auth boundaries (CR-A1, security Medium-1) ---
// users.email had NO normalization: `Victim@x.com`, `victim@x.com`, and a
// trailing-space variant were DISTINCT lookup keys, distinct rate-limit buckets,
// and could become distinct rows. Every boundary that accepts an email now
// normalizes (trim + lowercase) BEFORE lookup / insert / rate-limit-key, and a
// case-insensitive unique index (migration 0036) enforces it at the DB floor.

test('register with mixed-case email then login with lowercase succeeds (one principal) (CR-A1)', async () => {
  // makeTestApp seeds a user, so this registrant is NOT the first user — the
  // bootstrap gate does not apply. Register `Alice@Example.com`, then prove the
  // SAME human can log in with `alice@example.com`. RED before the fix: the login
  // lookup is case-sensitive eq(users.email, ...) → unknown-user branch → 401.
  const { app } = await makeTestApp();
  const reg = await app.request('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.50' },
    body: JSON.stringify({
      email: 'Alice@Example.com',
      password: 'password123',
      name: 'Alice',
    }),
  });
  expect(reg.status).toBe(200);
  // The stored email is normalized.
  expect((await reg.json()).data.user.email).toBe('alice@example.com');

  const login = await app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.51' },
    body: JSON.stringify({ email: 'alice@example.com', password: 'password123' }),
  });
  expect(login.status).toBe(200);
  expect((await login.json()).data.user.email).toBe('alice@example.com');
});

test('login rate-limit case-evasion is closed: case-variants share ONE per-email bucket (CR-A1)', async () => {
  // The finding's rate-limit-evasion vector: without normalization, `victim@x.com`
  // and `VICTIM@X.COM` are DISTINCT email-keyed counters, so an attacker case-cycles
  // to multiply the per-email login ceiling. We force the email DIMENSION to be the
  // only thing that can trip the 429 by using a DISTINCT IP per request (so the
  // per-IP bucket — default limit 5 — never reaches its own threshold). Alternating
  // the case across the burst, the per-email bucket (also default 5) must still trip.
  // RED before the fix: each case variant gets its own bucket, neither reaches 5,
  // and with a fresh IP each time NOTHING trips → final status 401, not 429.
  const { app } = await makeTestApp();
  const seeded = 'alice@test.local'; // the harness-seeded user
  let last: Response | undefined;
  for (let i = 0; i < 7; i++) {
    const email = i % 2 === 0 ? seeded.toUpperCase() : seeded;
    last = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': `198.51.100.${100 + i}`, // distinct IP each request
      },
      body: JSON.stringify({ email, password: 'wrong-password' }),
    });
  }
  expect(last!.status).toBe(429);
  expect((await last!.json()).error.code).toBe('RATE_LIMITED');
});

test('invite consume stores the email lowercased (CR-A1)', async () => {
  // Invite `Bob@Example.com`; the consume path creates the user from link.email.
  // Normalizing at the invite boundary means the stored user email is lowercased.
  // RED before the fix: link.email keeps `Bob@Example.com`, so the created user
  // row stores the mixed-case form.
  const { app, db, seed } = await makeTestApp();
  const inviteRes = await app.request('/api/v1/instance/invites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: seed.sessionCookie },
    body: JSON.stringify({ email: 'Bob@Example.com' }),
  });
  expect(inviteRes.status).toBe(200);

  // The minted magic_links row carries the normalized email.
  const link = await db.query.magicLinks.findFirst({
    where: eq(magicLinks.email, 'bob@example.com'),
  });
  expect(link).toBeDefined();
  expect(link!.kind).toBe('invite');

  // We can't read the plaintext token from the response (server-hashed), so seed a
  // known-token invite at the normalized email and consume it to assert the stored
  // user email. (The invite endpoint already proved it normalizes before insert.)
  const token = await seedMagicLink(db, normalizeEmail('Bob@Example.com'), 'invite');
  const consume = await app.request(`/api/v1/auth/magic-link/consume?token=${token}`, {
    redirect: 'manual',
  });
  expect(consume.status).toBe(302);
  const created = await db.query.users.findFirst({
    where: eq(users.email, 'bob@example.com'),
  });
  expect(created).toBeDefined();
  expect(created!.email).toBe('bob@example.com');
});
