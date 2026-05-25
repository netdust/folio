import type { Context, MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { apiTokens, users } from '../db/schema.ts';
import type { ApiToken } from '../db/schema.ts';
import { hashToken } from '../lib/auth.ts';
import { HTTPError } from '../lib/http.ts';
import type { AuthContext } from './auth.ts';

/** Read Bearer token from Authorization header, look up by hash, attach to context. */
export const attachToken: MiddlewareHandler<AuthContext> = async (c, next) => {
  const header = c.req.header('Authorization');
  if (!header || !header.startsWith('Bearer ')) {
    c.set('token', null);
    return next();
  }
  const raw = header.slice('Bearer '.length).trim();
  if (!raw) {
    c.set('token', null);
    return next();
  }
  const row = await db.query.apiTokens.findFirst({
    where: eq(apiTokens.tokenHash, hashToken(raw)),
  });
  c.set('token', row ?? null);
  // Best-effort lastUsedAt bump; failure must not block the request.
  if (row) {
    Promise.resolve(
      db
        .update(apiTokens)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiTokens.id, row.id)),
    ).catch(() => {});

    // When the request has no session user yet, resolve the token's creator
    // into the user context. Downstream handlers (createdBy, updatedBy, event
    // actor) can then use a single `getUser(c)` call without branching on
    // token vs session. attachUser runs first in the chain, so if a session
    // cookie was present and valid we leave that user in place.
    const sessionUser = c.get('user');
    if (!sessionUser && row.createdBy) {
      const creator = await db.query.users.findFirst({
        where: eq(users.id, row.createdBy),
      });
      if (creator) c.set('user', creator);
    }
  }
  return next();
};

export const requireToken: MiddlewareHandler<AuthContext> = async (c, next) => {
  const t = c.get('token');
  if (!t) throw new HTTPError('UNAUTHENTICATED', 'API token required', 401);
  return next();
};

/** Factory: require the token to carry the given scope. */
export function requireScope(scope: string): MiddlewareHandler<AuthContext> {
  return async (c, next) => {
    const t = c.get('token');
    const user = c.get('user');
    // Session-authenticated requests bypass scope checks; membership is the gate.
    if (user && !t) return next();
    if (!t) throw new HTTPError('UNAUTHENTICATED', 'API token required', 401);
    if (!t.scopes.includes(scope)) {
      throw new HTTPError('FORBIDDEN_SCOPE', `token missing required scope: ${scope}`, 403);
    }
    return next();
  };
}

/** Composite: passes if either a valid session OR a valid Bearer token is attached. */
export const requireUserOrToken: MiddlewareHandler<AuthContext> = async (c, next) => {
  const user = c.get('user');
  const token = c.get('token');
  if (!user && !token) {
    throw new HTTPError('UNAUTHENTICATED', 'session cookie or API token required', 401);
  }
  return next();
};

export function getToken(c: Context<AuthContext>): ApiToken {
  const t = c.get('token');
  if (!t) throw new Error('token not attached - requireToken missing?');
  return t;
}
