import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { apiTokens } from '../db/schema.ts';
import { canSeeWorkspace, userRole } from '../lib/access.ts';
import { HTTPError, jsonOk } from '../lib/http.ts';
import { mintToken, serializeApiToken } from '../lib/token-reach.ts';
import {
  type AuthContext,
  getUser,
  requireSessionUser,
  requireUser,
} from '../middleware/auth.ts';

const tokensRoute = new Hono<AuthContext>();
tokensRoute.use('*', requireUser);

tokensRoute.get('/:workspaceId', async (c) => {
  const user = getUser(c);
  const workspaceId = c.req.param('workspaceId');
  // Post-tenancy: a user may manage a workspace's tokens iff they can SEE the
  // workspace (the access.ts convergence point), not via a membership row.
  if (!(await canSeeWorkspace(db, user.id, workspaceId))) {
    throw new HTTPError('FORBIDDEN', 'no access to this workspace', 403);
  }
  const rows = await db.query.apiTokens.findMany({
    where: eq(apiTokens.workspaceId, workspaceId),
  });
  return jsonOk(c, {
    tokens: rows.map(serializeApiToken),
  });
});

tokensRoute.post(
  '/:workspaceId',
  // B round 5 #1 — session-only. Pre-fix a stolen workspace Bearer could mint a
  // higher-scope replacement (POST /tokens), because attachToken hydrates
  // c.user from token.createdBy so requireUser was satisfied. requireSession
  // rejects authMethod === 'token' with 403. Threat model mitigation 11.
  // Round 6 #6 — composite swap (was `requireSession`).
  requireSessionUser,
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
    const workspaceId = c.req.param('workspaceId');
    // Post-tenancy: managing a workspace's tokens requires SEEING it.
    if (!(await canSeeWorkspace(db, user.id, workspaceId))) {
      throw new HTTPError('FORBIDDEN', 'no access to this workspace', 403);
    }

    const { name, scopes, expires_in_days } = c.req.valid('json');
    // This route ALWAYS pins to the URL workspace. Instance (reach=null) tokens
    // are minted ONLY via POST /instance/tokens (the prior reach=null branch here
    // was dead — no caller passed it — and was a duplicate instance-mint path).
    // Scope ceiling = the caller's instance role; mintToken enforces it + inserts
    // + returns the plaintext exactly once (the single mint convergence point).
    const ceilingRole = await userRole(db, user.id);
    const minted = await mintToken(db, {
      ceilingRole,
      scopes,
      reach: workspaceId,
      name,
      createdBy: user.id,
      expiresInDays: expires_in_days,
    });
    return jsonOk(c, minted, 201);
  },
);

// B round 5 #2 — session-only. Pre-fix a stolen workspace Bearer could revoke
// peer Bearers (including a CI/CD token belonging to the workspace owner),
// because attachToken hydrates user from token.createdBy. Threat mitigation 11.
// Round 6 #6 — composite swap (was `requireSession`).
tokensRoute.delete('/:workspaceId/:tokenId', requireSessionUser, async (c) => {
  const user = getUser(c);
  const workspaceId = c.req.param('workspaceId');
  const tokenId = c.req.param('tokenId');
  // Post-tenancy: managing a workspace's tokens requires SEEING it.
  if (!(await canSeeWorkspace(db, user.id, workspaceId))) {
    throw new HTTPError('FORBIDDEN', 'no access to this workspace', 403);
  }
  await db
    .delete(apiTokens)
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.workspaceId, workspaceId)));
  return jsonOk(c, { ok: true });
});

export { tokensRoute };
