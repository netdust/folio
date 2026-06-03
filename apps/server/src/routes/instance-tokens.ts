import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db/client.ts';
import { apiTokens, memberships } from '../db/schema.ts';
import { HTTPError, jsonOk } from '../lib/http.ts';
import { getSystemWorkspaceId } from '../lib/system-workspace.ts';
import { type AuthContext, getUser, requireSessionUser } from '../middleware/auth.ts';

/**
 * A12 — instance-token listing surface.
 *
 * `api_tokens.workspace_id` is nullable: null = an INSTANCE token (reach across
 * every workspace, minted only by a __system owner/admin via the A7 reach gate).
 * The per-workspace list (GET /api/v1/w/:wslug/tokens/:workspaceId) filters
 * `WHERE workspace_id = <id>`, which correctly EXCLUDES instance (null) tokens —
 * they are not workspace-scoped. The consequence is that instance tokens are
 * INVISIBLE to management. This route is the read-site that closes that gap.
 *
 * Gate (T1 parity with the A7 mint gate): SESSION user only (no bearers — a
 * stolen instance bearer must not enumerate its peers) AND that user must be an
 * owner/admin of __system (the instance-admin boundary). NEVER returns tokenHash.
 *
 * Reach is immutable (T2) and there is no instance-token DELETE here: this is a
 * listing-only surface. Per-token revocation stays on the workspace-scoped DELETE
 * (a future task can add an instance-scoped revoke if needed).
 */
const instanceTokensRoute = new Hono<AuthContext>();

// Session-only: requireSessionUser rejects authMethod === 'token' (bearers) with
// 403 even when attachToken hydrated c.user from token.createdBy.
instanceTokensRoute.use('*', requireSessionUser);

instanceTokensRoute.get('/', async (c) => {
  const user = getUser(c);

  // Instance-admin gate (T1): owner/admin of __system, the same membership the
  // A7 mint path checks before allowing a reach=null mint.
  const systemId = await getSystemWorkspaceId(db);
  const sysM = await db.query.memberships.findFirst({
    where: and(eq(memberships.workspaceId, systemId), eq(memberships.userId, user.id)),
  });
  if (sysM?.role !== 'owner' && sysM?.role !== 'admin') {
    throw new HTTPError(
      'FORBIDDEN',
      'instance token administration requires a __system owner/admin',
      403,
    );
  }

  const rows = await db.query.apiTokens.findMany({
    where: isNull(apiTokens.workspaceId),
  });
  return jsonOk(c, {
    tokens: rows.map(({ tokenHash: _omit, ...t }) => t),
  });
});

export { instanceTokensRoute };
