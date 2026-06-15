import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { magicLinks, users } from '../db/schema.ts';
import { env } from '../env.ts';
import { userRole } from '../lib/access.ts';
import {
  createSession,
  deleteSession,
  hashPassword,
  hashToken,
  newMagicToken,
  verifyPassword,
} from '../lib/auth.ts';
import { clientIp } from '../lib/client-ip.ts';
import { sendMagicLink } from '../lib/email.ts';
import { HTTPError, jsonOk } from '../lib/http.ts';
import { checkRateLimit } from '../lib/rate-limit.ts';
import { designateInstanceOwner } from '../lib/system-workspace.ts';
import { type AuthContext, getUser, requireUser } from '../middleware/auth.ts';

const auth = new Hono<AuthContext>();

const SESSION_COOKIE = 'folio_session';

// M1 (audit H6) — timing-oracle close. The /login unknown-user branch runs a
// dummy argon2 verify against THIS hash before throwing 401, so an unknown email
// costs the same argon2 wall-clock as a wrong password for a real user. Computed
// ONCE at module load (top-level await — valid ESM under Bun); the constant body
// is irrelevant, only the verify cost matters. (M4.)
const DUMMY_PASSWORD_HASH = await hashPassword('folio-dummy-verify-target');

const cookieOpts = {
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'Lax' as const,
  path: '/',
};

// --- Email + password ---

auth.post(
  '/register',
  zValidator(
    'json',
    z.object({
      email: z.string().email(),
      password: z.string().min(8),
      name: z.string().min(1),
    }),
  ),
  async (c) => {
    const { email, password, name } = c.req.valid('json');

    // M1 — close the registration race (A1): the FIRST user becomes the instance
    // owner, but only behind the bootstrap flag. Read the flag LIVE (the env
    // singleton is mutated by tests; never destructure at module load).
    const anyUser = await db.query.users.findFirst({});
    const isFirstUser = !anyUser;
    if (isFirstUser && !env.FOLIO_ALLOW_BOOTSTRAP_REGISTRATION) {
      throw new HTTPError(
        'REGISTRATION_CLOSED',
        'instance owner must be set via FOLIO_INSTANCE_OWNER or enable FOLIO_ALLOW_BOOTSTRAP_REGISTRATION',
        403,
      );
    }

    const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (existing) throw new HTTPError('EMAIL_TAKEN', 'email already registered', 400);

    const id = nanoid();
    const passwordHash = await hashPassword(password);
    await db.insert(users).values({ id, email, passwordHash, name });

    // First registrant becomes the instance owner (users.role='owner').
    //
    // Atomicity: the user row is committed before designation. If designate
    // throws we COMPENSATE by deleting the just-created user, returning the
    // instance to the zero-users state. Without this, a mid-failure would leave
    // a committed user → isFirstUser=false forever + EMAIL_TAKEN on retry → the
    // instance is permanently ownerless via register.
    if (isFirstUser) {
      try {
        await designateInstanceOwner(db, email);
      } catch (err) {
        await db.delete(users).where(eq(users.id, id)); // roll back the user
        throw err;
      }
    }

    const session = await createSession(id);
    setCookie(c, SESSION_COOKIE, session.id, { ...cookieOpts, expires: session.expiresAt });
    return jsonOk(c, { user: { id, email, name } });
  },
);

auth.post(
  '/login',
  zValidator('json', z.object({ email: z.string().email(), password: z.string() })),
  async (c) => {
    const { email, password } = c.req.valid('json');

    // M1 (audit H6) — throttle BEFORE any expensive work. Two independent
    // counters: per-IP (blunts a single host hammering many emails) AND per-email
    // (blunts a botnet hammering one account). Either tripping → 429. The IP comes
    // from the single clientIp() source (SA-4). The throttle fails OPEN on a store
    // error, so this can never brick login.
    const [ipOk, emailOk] = await Promise.all([
      checkRateLimit(db, 'login', `ip:${clientIp(c)}`),
      checkRateLimit(db, 'login', `email:${email}`),
    ]);
    if (!ipOk || !emailOk) {
      throw new HTTPError('RATE_LIMITED', 'too many attempts, try again later', 429);
    }

    const user = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (!user || !user.passwordHash) {
      // M1 (audit H6) — close the user-enumeration timing oracle. An unknown email
      // (or a passwordless user) must cost the SAME argon2 wall-clock as a wrong
      // password, so we run a dummy verify and DISCARD the result before throwing.
      // Without this, the missing user short-circuits the verify and the fast 401
      // leaks "this email has no account". (M4.)
      await verifyPassword(password, DUMMY_PASSWORD_HASH);
      throw new HTTPError('UNAUTHENTICATED', 'invalid credentials', 401);
    }
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) throw new HTTPError('UNAUTHENTICATED', 'invalid credentials', 401);

    const session = await createSession(user.id);
    setCookie(c, SESSION_COOKIE, session.id, { ...cookieOpts, expires: session.expiresAt });
    return jsonOk(c, { user: { id: user.id, email: user.email, name: user.name } });
  },
);

auth.post('/logout', async (c) => {
  const sessionId = c.req.header('cookie')?.match(/folio_session=([^;]+)/)?.[1];
  if (sessionId) await deleteSession(sessionId);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return jsonOk(c, { ok: true });
});

auth.get('/me', requireUser, async (c) => {
  const u = getUser(c);
  // Post-tenancy boot identity, all server-authoritative. Two independent reads
  // run concurrently:
  //   - userRole: the caller's INSTANCE role (users.role; one instance = one
  //     team). `is_instance_admin` is the derived owner||admin signal. Both are
  //     top-level — properties of the boot identity, not the user record.
  //   - ai_configured: PRESENCE-only — does ANY instance AI key exist? Readable
  //     by every user (no admin gate, no key material); drives the body editor's
  //     AI slash commands. The key LIST is admin-gated; this is just "is an LLM
  //     reachable". (is_system_member is GONE — Phase 4 dropped __system.)
  const [role, anyAiKey] = await Promise.all([
    userRole(db, u.id),
    db.query.aiKeys.findFirst({ columns: { id: true } }),
  ]);
  return jsonOk(c, {
    user: { id: u.id, email: u.email, name: u.name },
    role, // instance role (owner|admin|member)
    is_instance_admin: role === 'owner' || role === 'admin',
    ai_configured: anyAiKey !== undefined,
  });
});

// --- Magic link ---

auth.post(
  '/magic-link/request',
  zValidator('json', z.object({ email: z.string().email() })),
  async (c) => {
    const { email } = c.req.valid('json');

    // M1 (audit H5): self-service sign-in only authenticates an EXISTING user.
    // For a stranger we mint nothing and send nothing — closing both the
    // flooding vector (no row written) and email enumeration (the response is
    // the same generic 200 whether or not the email has an account). New
    // members arrive ONLY via an admin invite (kind:'invite').
    const user = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (!user) return jsonOk(c, { ok: true });

    // M1 (audit H6) — throttle a REAL user's link requests (a stranger already
    // short-circuited above, so this only limits accounts that exist). On throttle
    // we return the SAME generic 200 with no row minted — never reveal the limit
    // to an enumerator, and don't let a flood mint links. (M2/M3.)
    if (!(await checkRateLimit(db, 'magic_link', `email:${email}`))) {
      return jsonOk(c, { ok: true });
    }

    const token = newMagicToken();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 15); // 15 min
    await db.insert(magicLinks).values({
      id: nanoid(),
      email,
      tokenHash: hashToken(token),
      expiresAt,
      kind: 'signin',
    });
    await sendMagicLink(email, token);
    return jsonOk(c, { ok: true });
  },
);

auth.get('/magic-link/consume', async (c) => {
  const token = c.req.query('token');
  if (!token) throw new HTTPError('INVALID_BODY', 'missing token', 400);

  const tokenHash = hashToken(token);
  const link = await db.query.magicLinks.findFirst({
    where: eq(magicLinks.tokenHash, tokenHash),
  });
  if (!link) throw new HTTPError('INVALID_TOKEN', 'invalid token', 400);
  if (link.usedAt) throw new HTTPError('INVALID_TOKEN', 'token already used', 400);
  if (link.expiresAt.getTime() < Date.now()) {
    throw new HTTPError('INVALID_TOKEN', 'token expired', 400);
  }

  // M1 (audit H5): account creation is gated by link provenance. An existing
  // user always signs in. A NEW user is created ONLY from an admin-issued invite
  // (kind:'invite'); a self-service sign-in link (kind!=='invite') for an unknown
  // email mints no principal — we burn the link and redirect to the same generic
  // outcome, so a stranger and a real user are indistinguishable (no enumeration).
  let user = await db.query.users.findFirst({ where: eq(users.email, link.email) });
  if (!user) {
    if (link.kind !== 'invite') {
      await db.update(magicLinks).set({ usedAt: new Date() }).where(eq(magicLinks.id, link.id));
      return c.redirect('/');
    }
    const id = nanoid();
    await db
      .insert(users)
      .values({ id, email: link.email, name: link.email.split('@')[0] ?? 'New User' });
    user = await db.query.users.findFirst({ where: eq(users.id, id) });
  }
  if (!user) throw new HTTPError('INTERNAL', 'failed to create user', 500);

  await db.update(magicLinks).set({ usedAt: new Date() }).where(eq(magicLinks.id, link.id));

  const session = await createSession(user.id);
  setCookie(c, SESSION_COOKIE, session.id, { ...cookieOpts, expires: session.expiresAt });

  // Redirect to the web app
  return c.redirect('/');
});

export { auth };
