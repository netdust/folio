import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { readSession } from '../lib/auth.ts';
import type { User, ApiToken } from '../db/schema.ts';
import { HTTPError } from '../lib/http.ts';

export interface AuthContext {
  Variables: {
    user: User | null;
    token: ApiToken | null;
    /**
     * How the current user (if any) was authenticated.
     * - `'session'` — a valid folio_session cookie hydrated a user in attachUser.
     * - `'token'`   — a valid Bearer hydrated a user in attachToken (when no
     *                 session existed).
     * - `undefined` — no user attached, or the cookie was present but invalid
     *                 (readSession returned null) AND no token hydrated a user.
     *
     * Routes that must be session-only (e.g. AI key management) check
     * `c.get('authMethod') === 'session'`, NOT cookie presence. A garbage or
     * expired cookie still arrives in the headers — checking the cookie alone
     * leaves a bypass (B round 3 fix #1).
     */
    authMethod?: 'session' | 'token';
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
  // Only stamp the flag when the cookie actually hydrated a user. A
  // present-but-invalid cookie must NOT mark the request as session-auth
  // (B round 3 fix #1 — cookie-presence bypass).
  if (user) c.set('authMethod', 'session');
  return next();
};

export const requireUser: MiddlewareHandler<AuthContext> = async (c, next) => {
  const user = c.get('user');
  if (!user) {
    throw new HTTPError('UNAUTHENTICATED', 'login required', 401);
  }
  return next();
};

/**
 * Session-only gate (B round 5 — threat model mitigation 11). Rejects with 403
 * when `authMethod === 'token'`. ALL routes that mutate auth grants, workspace
 * ownership/identity, or BYOK credentials MUST use this middleware. See the
 * plan's threat model section for the full enumerated route table — new routes
 * that fit the pattern MUST wire it in the same commit they are introduced.
 *
 * Pre-fix rounds 3-4 inlined `if (c.get('authMethod') === 'token') throw …`
 * on each route. The asymmetry that round 5 caught (tokens.ts + workspaces.ts
 * had no guard) is exactly what an enumerated mitigation table without a
 * shared helper enables. Now there's one helper; routes pull it explicitly.
 */
export const requireSession: MiddlewareHandler<AuthContext> = async (c, next) => {
  if (c.get('authMethod') === 'token') {
    throw new HTTPError('FORBIDDEN', 'This route is session-only (no API tokens)', 403);
  }
  return next();
};

export function getUser(c: Context<AuthContext>): User {
  const user = c.get('user');
  if (!user) throw new Error('user not attached - requireUser missing?');
  return user;
}
