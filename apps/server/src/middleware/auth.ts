import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { readSession } from '../lib/auth.ts';
import type { User } from '../db/schema.ts';

export interface AuthContext {
  Variables: {
    user: User | null;
  };
}

export const attachUser: MiddlewareHandler<AuthContext> = async (c, next) => {
  const sessionId = getCookie(c, 'folio_session');
  if (!sessionId) {
    c.set('user', null);
    return next();
  }
  const user = await readSession(sessionId);
  c.set('user', user);
  return next();
};

export const requireUser: MiddlewareHandler<AuthContext> = async (c, next) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'unauthenticated' }, 401);
  }
  return next();
};

export function getUser(c: Context<AuthContext>): User {
  const user = c.get('user');
  if (!user) throw new Error('user not attached - requireUser missing?');
  return user;
}
