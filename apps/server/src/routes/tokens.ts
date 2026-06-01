import { zValidator } from '@hono/zod-validator';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { apiTokens, memberships } from '../db/schema.ts';
import { newApiToken } from '../lib/auth.ts';
import { roleToScopes } from '../lib/agent-schema.ts';
import { HTTPError, jsonOk } from '../lib/http.ts';
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
  const m = await db.query.memberships.findFirst({
    where: and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, user.id)),
  });
  if (!m) throw new HTTPError('FORBIDDEN', 'not a member', 403);
  const rows = await db.query.apiTokens.findMany({
    where: eq(apiTokens.workspaceId, workspaceId),
  });
  return jsonOk(c, {
    tokens: rows.map(({ tokenHash: _omit, ...t }) => t),
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
    }),
  ),
  async (c) => {
    const user = getUser(c);
    const workspaceId = c.req.param('workspaceId');
    const m = await db.query.memberships.findFirst({
      where: and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, user.id)),
    });
    if (!m) throw new HTTPError('FORBIDDEN', 'not a member', 403);

    const { name, scopes } = c.req.valid('json');
    // Scope ceiling: a caller may only mint a token carrying scopes their own
    // role already grants (the SAME roleToScopes ceiling the runner enforces at
    // execution time). Without this, a member mints a config:write/agents:write
    // token and uses it directly against owner-only routes — escalating past the
    // agent∩caller ceiling at the one place a human creates raw authority.
    const allowed = roleToScopes(m.role);
    const over = scopes.filter((s) => !allowed.includes(s));
    if (over.length > 0) {
      throw new HTTPError(
        'FORBIDDEN_SCOPE',
        `role '${m.role}' cannot mint a token with scope(s): ${over.join(', ')}`,
        403,
      );
    }
    const { token, hash } = newApiToken();
    const id = nanoid();
    await db.insert(apiTokens).values({
      id,
      workspaceId,
      name,
      tokenHash: hash,
      scopes,
      createdBy: user.id,
    });
    // Return the plaintext token EXACTLY ONCE.
    return jsonOk(c, { id, name, token, scopes }, 201);
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
  const m = await db.query.memberships.findFirst({
    where: and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, user.id)),
  });
  if (!m) throw new HTTPError('FORBIDDEN', 'not a member', 403);
  await db
    .delete(apiTokens)
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.workspaceId, workspaceId)));
  return jsonOk(c, { ok: true });
});

export { tokensRoute };
