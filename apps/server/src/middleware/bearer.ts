import type { Context, MiddlewareHandler } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { apiTokens, documents, users } from '../db/schema.ts';
import type { ApiToken } from '../db/schema.ts';
import { hashToken } from '../lib/auth.ts';
import { HTTPError } from '../lib/http.ts';
import type { AuthContext } from './auth.ts';
import type { ScopeContext } from './scope.ts';

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
  //
  // Round 7 #10 — replace empty .catch(() => {}) with console.warn. Pre-
  // round-7 a SQLITE_BUSY here silently dropped, which left the AI tab's
  // "last used N days ago" stale (operators couldn't tell whether a key
  // was unused or just lying about it). Surface via console.warn so ops
  // have a grep target. Failure still must not block — UPDATE is async-
  // fire-and-forget; we never await it.
  if (row) {
    Promise.resolve(
      db
        .update(apiTokens)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiTokens.id, row.id)),
    ).catch((err: unknown) => {
      console.warn(
        '[bearer] lastUsedAt bump failed:',
        err instanceof Error ? err.message : err,
      );
    });

    // When the request has no session user yet, resolve the token's creator
    // into the user context. Downstream handlers (createdBy, updatedBy, event
    // actor) can then use a single `getUser(c)` call without branching on
    // token vs session. attachUser runs first in the chain, so if a session
    // cookie was present and valid we leave that user (and its authMethod)
    // in place — a stray Authorization header does NOT downgrade a session
    // to 'token' auth (B round 3 fix #1).
    const sessionUser = c.get('user');
    if (!sessionUser && row.createdBy) {
      const creator = await db.query.users.findFirst({
        where: eq(users.id, row.createdBy),
      });
      if (creator) {
        c.set('user', creator);
        c.set('authMethod', 'token');
      }
    }
  }
  return next();
};

export const requireToken: MiddlewareHandler<AuthContext> = async (c, next) => {
  const t = c.get('token');
  if (!t) throw new HTTPError('UNAUTHENTICATED', 'API token required', 401);
  return next();
};

// Legacy granular scopes that pre-date the Phase 2 consolidation into the
// single canonical `config:write`. Tokens minted before that consolidation
// still carry one of these; we grandfather them in so existing PATs keep
// passing `requireScope('config:write')` without an upgrade path. These can
// no longer be MINTED — the POST /tokens ceiling rejects any scope outside
// roleToScopes(role), and config:write is the only config scope offered there.
const CONFIG_WRITE_LEGACY_ALIASES = [
  'fields:write',
  'views:write',
  'tables:write',
  'statuses:write',
];

/** Factory: require the token to carry the given scope. */
export function requireScope(scope: string): MiddlewareHandler<AuthContext> {
  return async (c, next) => {
    const t = c.get('token');
    const user = c.get('user');
    // Session-authenticated requests bypass scope checks; membership is the gate.
    if (user && !t) return next();
    if (!t) throw new HTTPError('UNAUTHENTICATED', 'API token required', 401);
    // The alias only applies to the config:write target — other scopes are
    // matched strictly, so a legacy scope never leaks into an unrelated grant.
    const holds =
      t.scopes.includes(scope) ||
      (scope === 'config:write' &&
        CONFIG_WRITE_LEGACY_ALIASES.some((a) => t.scopes.includes(a)));
    if (!holds) {
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

// S1: shared resolution/intersection moved to lib/agent-projects.ts so all
// three read paths (this middleware, SSE, mention parser) share one
// fail-closed implementation.
export { intersectAgentProjects as intersect } from '../lib/agent-projects.ts';
import { intersectAgentProjects, resolveAgentProjects } from '../lib/agent-projects.ts';

/**
 * Resource-scope check for bearer requests. Composes after `requireScope`.
 *
 * Bypasses when:
 *  - the request is session-authenticated (no token) — membership is the gate;
 *  - the request is not project-scoped (no `:pslug` resolved into context);
 *  - the token is a human PAT (no agent_id) — Phase 3+ adds human PAT
 *    enforcement once a UI for narrowing exists.
 */
export function requireResource(): MiddlewareHandler<AuthContext & ScopeContext> {
  return async (c, next) => {
    const token = c.get('token');
    const project = c.get('project');
    if (!token) return next();
    if (!project) return next();
    if (!token.agentId) return next();

    const agent = await db.query.documents.findFirst({
      where: eq(documents.id, token.agentId),
    });
    if (!agent || agent.type !== 'agent') {
      throw new HTTPError('FORBIDDEN_RESOURCE', 'agent for this token no longer exists', 403);
    }
    const agentProjects = resolveAgentProjects(agent);
    const effective = intersectAgentProjects(agentProjects, token.projectIds ?? null);
    if (!effective.includes('*') && !effective.includes(project.id)) {
      throw new HTTPError(
        'FORBIDDEN_RESOURCE',
        `agent not allow-listed for project ${project.slug}`,
        403,
      );
    }
    return next();
  };
}
