import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { apiTokens } from '../db/schema.ts';
import { HTTPError, jsonOk } from '../lib/http.ts';
import { requireInstanceAdmin } from '../lib/system-workspace.ts';
import { mintToken, serializeApiToken } from '../lib/token-reach.ts';
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

// Mint an instance (reach=null) token from the instance surface, so an admin
// never has to mint a cross-workspace token from inside a single workspace (the
// only prior path was POST /w/:wslug/tokens with body workspaceId:null, which
// the UI couldn't reach without first picking an arbitrary workspace).
//
// Same guarantees as the workspace POST, minus the workspace: session-only mount
// (no bearer can self-mint a peer — a stolen instance bearer is owner-equivalent),
// requireInstanceAdmin (only an owner/admin mints instance reach), and the SAME
// roleToScopes ceiling (the caller's instance role can't mint scopes it lacks).
// reach is hard-wired null — this route NEVER mints a workspace-pinned token.
instanceTokensRoute.post(
  '/',
  zValidator(
    'json',
    z.object({
      name: z.string().min(1).max(80),
      scopes: z.array(z.string()).default(['documents:read', 'documents:write']),
      // Optional lifetime in days (≤10y). Omitted ⟹ a never-expiring token.
      expires_in_days: z.number().int().positive().max(3650).optional(),
    }),
  ),
  async (c) => {
    const user = getUser(c);
    // requireInstanceAdmin returns the caller's instance role — the scope ceiling.
    const ceilingRole = await requireInstanceAdmin(db, user.id);
    const { name, scopes, expires_in_days } = c.req.valid('json');
    // reach hard-wired null (instance) — this route NEVER pins to a workspace.
    // mintToken is the shared convergence point (ceiling-check + insert +
    // reveal-once) also used by the per-workspace POST, so the two can't drift.
    const minted = await mintToken(db, {
      ceilingRole,
      scopes,
      reach: null,
      name,
      createdBy: user.id,
      expiresInDays: expires_in_days,
    });
    return jsonOk(c, minted, 201);
  },
);

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
