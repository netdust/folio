import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { magicLinks, users } from '../db/schema.ts';
import { env } from '../env.ts';
import {
  createSession,
  deleteSession,
  hashPassword,
  hashToken,
  newMagicToken,
  verifyPassword,
} from '../lib/auth.ts';
import { sendMagicLink } from '../lib/email.ts';
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
    const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (existing) return c.json({ error: 'email already registered' }, 400);

    const id = nanoid();
    const passwordHash = await hashPassword(password);
    await db.insert(users).values({ id, email, passwordHash, name });

    const session = await createSession(id);
    setCookie(c, SESSION_COOKIE, session.id, { ...cookieOpts, expires: session.expiresAt });
    return c.json({ user: { id, email, name } });
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
    if (!user || !user.passwordHash) return c.json({ error: 'invalid credentials' }, 401);
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) return c.json({ error: 'invalid credentials' }, 401);

    const session = await createSession(user.id);
    setCookie(c, SESSION_COOKIE, session.id, { ...cookieOpts, expires: session.expiresAt });
    return c.json({ user: { id: user.id, email: user.email, name: user.name } });
  },
);

auth.post('/logout', async (c) => {
  const sessionId = c.req.header('cookie')?.match(/folio_session=([^;]+)/)?.[1];
  if (sessionId) await deleteSession(sessionId);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

auth.get('/me', requireUser, (c) => {
  const u = getUser(c);
  return c.json({ user: { id: u.id, email: u.email, name: u.name } });
});

// --- Magic link ---

auth.post(
  '/magic/request',
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
    return c.json({ ok: true });
  },
);

auth.get('/magic/verify', async (c) => {
  const token = c.req.query('token');
  if (!token) return c.json({ error: 'missing token' }, 400);

  const tokenHash = hashToken(token);
  const link = await db.query.magicLinks.findFirst({
    where: eq(magicLinks.tokenHash, tokenHash),
  });
  if (!link) return c.json({ error: 'invalid token' }, 400);
  if (link.usedAt) return c.json({ error: 'token already used' }, 400);
  if (link.expiresAt.getTime() < Date.now()) return c.json({ error: 'token expired' }, 400);

  // upsert user
  let user = await db.query.users.findFirst({ where: eq(users.email, link.email) });
  if (!user) {
    const id = nanoid();
    await db.insert(users).values({ id, email: link.email, name: link.email.split('@')[0] ?? 'New User' });
    user = await db.query.users.findFirst({ where: eq(users.id, id) });
  }
  if (!user) return c.json({ error: 'failed to create user' }, 500);

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
