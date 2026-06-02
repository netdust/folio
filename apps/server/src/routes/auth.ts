import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { magicLinks, users } from '../db/schema.ts';
import { env } from '../env.ts';
import { bootstrapSystemWorkspace, designateInstanceOwner } from '../lib/system-workspace.ts';
import {
  createSession,
  deleteSession,
  hashPassword,
  hashToken,
  newMagicToken,
  verifyPassword,
} from '../lib/auth.ts';
import { sendMagicLink } from '../lib/email.ts';
import { HTTPError, jsonOk } from '../lib/http.ts';
import { type AuthContext, getUser, requireUser } from '../middleware/auth.ts';

const auth = new Hono<AuthContext>();

const SESSION_COOKIE = 'folio_session';
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

    // First registrant (flag on) becomes the instance owner of the __system
    // library workspace.
    //
    // Atomicity (review fix #3): the user row is committed before bootstrap, but
    // createDocument (inside designateInstanceOwner) uses its own transaction on
    // the module db proxy, so we cannot wrap all three in one outer tx. Instead,
    // if bootstrap/designate throws we COMPENSATE by deleting the just-created
    // user, returning the instance to the zero-users state. Without this, a
    // mid-failure would leave a committed user → isFirstUser=false forever +
    // EMAIL_TAKEN on retry → the instance is permanently ownerless via register.
    if (isFirstUser) {
      try {
        await bootstrapSystemWorkspace(db);
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
  zValidator(
    'json',
    z.object({ email: z.string().email(), password: z.string() }),
  ),
  async (c) => {
    const { email, password } = c.req.valid('json');
    const user = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (!user || !user.passwordHash) {
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

auth.get('/me', requireUser, (c) => {
  const u = getUser(c);
  return jsonOk(c, { user: { id: u.id, email: u.email, name: u.name } });
});

// --- Magic link ---

auth.post(
  '/magic-link/request',
  zValidator('json', z.object({ email: z.string().email() })),
  async (c) => {
    const { email } = c.req.valid('json');
    const token = newMagicToken();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 15); // 15 min
    await db.insert(magicLinks).values({
      id: nanoid(),
      email,
      tokenHash: hashToken(token),
      expiresAt,
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

  // upsert user
  let user = await db.query.users.findFirst({ where: eq(users.email, link.email) });
  if (!user) {
    const id = nanoid();
    await db.insert(users).values({ id, email: link.email, name: link.email.split('@')[0] ?? 'New User' });
    user = await db.query.users.findFirst({ where: eq(users.id, id) });
  }
  if (!user) throw new HTTPError('INTERNAL', 'failed to create user', 500);

  await db
    .update(magicLinks)
    .set({ usedAt: new Date() })
    .where(eq(magicLinks.id, link.id));

  const session = await createSession(user.id);
  setCookie(c, SESSION_COOKIE, session.id, { ...cookieOpts, expires: session.expiresAt });

  // Redirect to the web app
  return c.redirect('/');
});

export { auth };
