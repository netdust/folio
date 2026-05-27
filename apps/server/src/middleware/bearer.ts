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
