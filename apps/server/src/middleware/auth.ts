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
 * Round 7 #14 — non-composite `requireSession` deleted as dead code. The round-6
 * #6 migration replaced every live importer with `requireSessionUser` (composite
 * with `requireUser`), which closes the ordering ambiguity the standalone gate
 * left open. The original was kept around `--just in case--`; an IDE
 * autocomplete grabbing it onto a new mutation route would silently lose the
 * `requireUser` half. Deletion is safer than commenting "use requireSessionUser
 * instead" — there's only one helper now and the type system makes it the only
 * spelling that compiles.
 *
 * Threat model mitigation 11 still applies to the same enumerated route table;
 * the gate now lives entirely inside `requireSessionUser` (below).
 */

/**
 * Composite: enforce session-only AND require an authenticated user.
 *
 * Round 6 #6 — middleware ordering across the 4 session-only routes was
 * asymmetric: `ai.ts` wired requireSession → requireUser at the router level;
 * `tokens.ts` / `settings.ts` / `workspaces.ts` wired requireUser at router
 * level and requireSession per-handler. Same external behavior in the happy
 * paths (token callers got 403, no-auth callers got 401) but the ORDER of
 * checks for a Bearer + invalid cookie request differed across files, and
 * a future maintainer could land a handler that forgets `requireSession`
 * and only get caught by a test.
 *
 * One canonical helper. Used on every route that mutates auth grants,
 * workspace identity, master secrets, or BYOK credentials (see threat model
 * mitigation 11 for the enumerated table).
 *
 * Order matters:
 *   1. authMethod === 'token' → 403 FORBIDDEN (precise: this is "wrong kind
 *      of auth", not "no auth")
 *   2. no user attached → 401 UNAUTHENTICATED
 * A garbage-cookie + valid-bearer request authenticates as 'token' (round 3
 * fix #1), so it falls into branch 1 and returns 403, not 401.
 */
export const requireSessionUser: MiddlewareHandler<AuthContext> = async (c, next) => {
  if (c.get('authMethod') === 'token') {
    throw new HTTPError('FORBIDDEN', 'This route is session-only (no API tokens)', 403);
  }
  if (!c.get('user')) {
    throw new HTTPError('UNAUTHENTICATED', 'login required', 401);
  }
  return next();
};

export function getUser(c: Context<AuthContext>): User {
  const user = c.get('user');
  if (!user) throw new Error('user not attached - requireUser missing?');
  return user;
}
