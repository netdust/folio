import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../db/client.ts';
import { apiTokens } from '../db/schema.ts';
import { HTTPError, jsonOk } from '../lib/http.ts';
import { requireInstanceAdmin } from '../lib/system-workspace.ts';
import { serializeApiToken } from '../lib/token-reach.ts';
import { type AuthContext, getUser, requireSessionUser } from '../middleware/auth.ts';

/**
 * A12 — instance-token administration surface (list + revoke).
 *
 * `api_tokens.workspace_id` is nullable: null = an INSTANCE token (reach across
 * every workspace, minted only by a __system owner/admin via the A7 reach gate).
 * The per-workspace list/delete (GET/DELETE /api/v1/w/:wslug/tokens/...) filter
 * `WHERE workspace_id = <id>`, which correctly EXCLUDES instance (null) tokens —
 * they are not workspace-scoped. The consequence is that instance tokens are
 * INVISIBLE and UN-REVOCABLE through the workspace surfaces. This route closes
 * both gaps (CR#5 added the revoke).
 *
 * Gate: SESSION user only (no bearers — a stolen instance bearer must not
 * enumerate or revoke its peers) AND that user must be an owner/admin of
 * __system (requireInstanceAdmin, the shared instance-admin boundary). NEVER
 * returns tokenHash (serializeApiToken).
 */
const instanceTokensRoute = new Hono<AuthContext>();

// Session-only. This route mounts on v1 (not wScope), where attachToken does
// NOT run — so a Bearer is never parsed here and `c.get('user')` is set only by
// a valid session cookie (attachUser). requireSessionUser's `!user → 401` is
// therefore the operative gate: a bearer-only request has no user and is
// rejected. (requireSessionUser also rejects authMethod==='token' as
// defense-in-depth, but that branch is unreachable at this mount.)
instanceTokensRoute.use('*', requireSessionUser);

instanceTokensRoute.get('/', async (c) => {
  const user = getUser(c);
  await requireInstanceAdmin(db, user.id);

  const rows = await db.query.apiTokens.findMany({
    where: isNull(apiTokens.workspaceId),
  });
  return jsonOk(c, { tokens: rows.map(serializeApiToken) });
});

// CR#5 — revoke an instance token. The per-workspace DELETE can't reach a
// null-workspace row (its `eq(workspaceId, <id>)` never matches null), so an
// instance token — owner-equivalent across the whole instance — would otherwise
// be un-revocable via HTTP. The `isNull(workspaceId)` predicate scopes this to
// instance tokens ONLY, so it can never delete a workspace-scoped token.
instanceTokensRoute.delete('/:tokenId', async (c) => {
  const user = getUser(c);
  await requireInstanceAdmin(db, user.id);

  const tokenId = c.req.param('tokenId');
  const deleted = await db
    .delete(apiTokens)
    .where(and(eq(apiTokens.id, tokenId), isNull(apiTokens.workspaceId)))
    .returning({ id: apiTokens.id });
  if (deleted.length === 0) {
    throw new HTTPError('NOT_FOUND', 'instance token not found', 404);
  }
  return jsonOk(c, { ok: true });
});

export { instanceTokensRoute };
