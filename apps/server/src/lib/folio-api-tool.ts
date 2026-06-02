/**
 * folio_api / folio_api_get — the operator agent's general in-process REST
 * bridge. The operator is an AGENT with the same caller-bounded reach the
 * outside agent (Claude Code over MCP) has — these two tools let it call any
 * token-scoped /api/v1 route in-process, gated by the risk classifier and the
 * Phase-1 `agent ∩ caller` ceiling. NOT a per-workspace seeded bot.
 *
 * `app` is exported at app.ts:34; a static import of it into lib/ cycles
 * (app → routes → lib), so dispatchAsCaller lazy-imports it inside the handler.
 */

import { eq, like } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { apiTokens, type ApiToken } from '../db/schema.ts';
import { registerTool, type ToolContext } from './agent-tools.ts';
import { newApiToken } from './auth.ts';

/**
 * Validate the `path` arg of folio_api/folio_api_get (mitigation P3-5).
 * Only relative paths under /api/v1/ are allowed; no scheme, no protocol-
 * relative, no traversal, no injection chars. Returns the path unchanged on
 * success; throws on rejection (surfaced to the model as a tool error).
 */
export function validateApiPath(path: string): string {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('folio_api: path must be a non-empty string');
  }
  if (path.includes('://') || path.startsWith('//')) {
    throw new Error('folio_api: path must be relative (no scheme/host)');
  }
  if (!path.startsWith('/api/v1/')) {
    throw new Error('folio_api: path must start with /api/v1/');
  }
  // Reject the SSE stream routes — they never close, so the tool's res.json()
  // would hang the run forever (prompt-injection self-DoS). The agent reads via
  // the REST list/get routes, never the live stream.
  if (/\/events\/?$/.test(path)) {
    throw new Error('folio_api: the live events stream is not callable via folio_api');
  }
  // Reject control chars (incl. null byte, newline, tab, DEL) — the contract
  // returns the path verbatim, so a future caller that logs/concats it must
  // not receive an embedded control char. Fail closed.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-char guard
  if (/[\x00-\x1f\x7f]/.test(path)) {
    throw new Error('folio_api: path contains a control character');
  }
  // NOTE: we do NOT decode percent-encoding here. This is safe ONLY because the
  // sole consumer is Hono's in-process app.request, whose WHATWG URL parsing does
  // not decode %2e/%2f into router path segments (encoded traversal → 404, not
  // escape). A future consumer that decodes or hits a filesystem path would
  // reopen %2e%2e traversal and must re-validate.
  if (path.includes('..') || path.includes('@') || path.includes('\\')) {
    throw new Error('folio_api: path contains a disallowed sequence');
  }
  return path;
}

export type RiskTier = 'low' | 'medium' | 'high';

/**
 * v1 risk proxy by resource type (mitigation P3-7). The real scorer (objects /
 * reversibility / workspace-wide / permissions) drops in here later without
 * re-plumbing — every mutation already routes through dryRun→render→apply.
 *
 * Rule order (first match wins):
 *  1. HIGH  — token mint/revoke, BYOK/settings writes, workspace-terminus
 *     rename/delete, permission/membership routes, explicit bulk. These create or
 *     destroy standing credentials, AI keys, memberships, or the workspace itself,
 *     so they REFUSE-with-plan rather than auto-apply. Reads (GET) never gate high.
 *  2. MEDIUM — structure config (tables/fields/views/statuses), the projects
 *     COLLECTION (/projects, /projects/:slug), and the bare project ITEM route
 *     (/p/:slug with NO further sub-resource segment). Reads (GET) are never medium.
 *  3. LOW   — everything else token-scoped, incl. document/comment/run writes that
 *     live UNDER a project (/p/:slug/<sub-resource>).
 *
 * The project-config rule is deliberately anchored to /projects(/:slug)? and to a
 * /p/:slug TERMINUS — it must NOT swallow /p/:slug/documents, /comments, /runs, etc.
 */
export function classifyRisk(
  method: string,
  path: string,
  body: Record<string, unknown>,
): RiskTier {
  // Normalize method case (defense-in-depth: a lowercase 'delete' still gates).
  const m = method.toUpperCase();

  // 1. High: credential/membership/workspace-terminus writes, or explicit bulk.
  if (/\/tokens(\/|$)/.test(path) && m !== 'GET') return 'high'; // mint/revoke standing credentials
  if (/\/(settings|ai-keys)(\/|$)/.test(path) && m !== 'GET') return 'high'; // BYOK key / settings (credential ops)
  if (/^\/api\/v1\/w\/[^/]+$/.test(path) && m !== 'GET') return 'high'; // workspace rename or delete
  if (/\/members?(\/|$)/.test(path) && m !== 'GET') return 'high';
  if (body && body.bulk === true) return 'high';

  // 2. Medium: structure/config writes.
  if (/\/(tables|fields|views|statuses)(\/|$)/.test(path)) return 'medium';
  // Project config: the projects collection / project item (real route shape),
  // OR the bare /p/:slug terminus (plan spec shape). Anchored to end-of-path so
  // sub-resources like /p/:slug/documents fall through to low.
  if (
    m !== 'GET' &&
    (/^\/api\/v1\/w\/[^/]+\/projects(\/[^/]+)?$/.test(path) ||
      /^\/api\/v1\/w\/[^/]+\/p\/[^/]+$/.test(path))
  ) {
    return 'medium';
  }

  // 3. Low: document writes + everything else token-scoped.
  return 'low';
}

/**
 * Call a Folio API route IN-PROCESS as the caller delegate (P3-1/2/3/4).
 * Mints a short-lived bearer mirroring `caller` (scopes/agentId/projectIds/
 * workspaceId verbatim — widening NOTHING), sends it as Authorization: Bearer
 * to app.request, and REVOKES it in a finally. The ccExecute mint/revoke
 * pattern in runner.ts. The no-mint seeded-ctx path is infeasible in
 * Hono 4.6.12 (app.request env arg sets c.env not the c.var store requireScope
 * reads; attachToken's app-wide mount in app.ts overwrites c.set('token') from
 * the header on every workspace route).
 *  - P3-1: scopes/agentId/projectIds copied verbatim (agent ∩ caller ceiling).
 *  - P3-2: plaintext only in the Authorization header — never logged/returned.
 *  - P3-3: row deleted in finally so no path leaves a live credential.
 */
export async function dispatchAsCaller(
  caller: ApiToken,
  method: string,
  path: string,
  body: unknown,
): Promise<Response> {
  const validPath = validateApiPath(path);
  const { token: plaintext, hash } = newApiToken();
  const mintedId = nanoid();
  await db.insert(apiTokens).values({
    id: mintedId,
    workspaceId: caller.workspaceId,
    name: `folio_api:${mintedId}`,
    tokenHash: hash,
    scopes: caller.scopes,
    agentId: caller.agentId,
    projectIds: caller.projectIds,
    createdBy: caller.createdBy,
  });
  try {
    const { app } = await import('../app.ts'); // lazy — avoids import cycle
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${plaintext}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    return await app.request(validPath, init);
  } finally {
    // Revoke the minted token on EVERY path. Swallow+log a revoke failure so it
    // neither masks the primary error nor crashes the caller; the boot sweep
    // (sweepOrphanedFolioApiTokens) is the backstop if this delete ever fails.
    try {
      await db.delete(apiTokens).where(eq(apiTokens.id, mintedId));
    } catch (err) {
      console.error(`[folio_api] failed to revoke minted token ${mintedId}:`, err);
    }
  }
}

/**
 * Boot-time backstop: delete any `folio_api:`-named tokens left live by a
 * crash or a revoke failure between dispatchAsCaller's insert and its finally.
 * These ephemeral tokens are minted per-request and revoked in the same call,
 * so any surviving at boot are orphans. Cheap, idempotent, self-healing — the
 * same defense-in-depth posture as recoverOrphanRuns / seedReactorCursors.
 * Returns the count deleted (for logging/tests).
 */
export async function sweepOrphanedFolioApiTokens(database = db): Promise<number> {
  const orphans = await database
    .delete(apiTokens)
    .where(like(apiTokens.name, 'folio_api:%'))
    .returning({ id: apiTokens.id });
  return orphans.length;
}

/**
 * Register the operator agent's general REST bridge tools into the shared
 * tool registry. Called from registerRealTools() in agent-tools-registry.ts
 * (the explicit-registration seam that breaks the circular import — this file
 * imports `registerTool` from agent-tools.ts, the registry imports this).
 *
 * folio_api_get (this task, P3-4/6): reads any token-scoped route by GET —
 * method is FORCED to GET (no `method` arg, `.strict()` rejects one), so the
 * model cannot smuggle a write through the read tool. Gated only by the token's
 * `documents:read` scope (executeTool checks requiredScope against BOTH the
 * run's token AND the caller). The write tool `folio_api` (gated, refuse-with-
 * plan) is registered in Task 5.
 */
export function registerFolioApiTools(): void {
  registerTool({
    name: 'folio_api_get',
    description:
      'Read any Folio resource by GET. path is a relative /api/v1/... path. Read-only — use folio_api for writes.',
    requiredScope: 'documents:read',
    schema: z.object({ path: z.string() }).strict(), // P3-6: no method field
    handler: async (args: { path: string }, ctx: ToolContext) => {
      const res = await dispatchAsCaller(ctx.token, 'GET', args.path, undefined); // P3-6: GET forced
      const json = await res.json().catch(() => null);
      // Deliberate {status, body} envelope (NOT the MCP textResult shape): the
      // runner JSON.stringifies any non-string tool return (runner.ts), so the
      // model sees the HTTP status + parsed body. Do not "fix" into textResult.
      return { status: res.status, body: json };
    },
  });
  registerTool({
    name: 'folio_api',
    description:
      'Write a Folio resource. method ∈ POST|PATCH|PUT|DELETE; path is a relative /api/v1/... path. ' +
      'High-risk actions are NOT applied automatically — the proposed plan is returned for approval. ' +
      'Use folio_api_get for reads.',
    requiredScope: 'config:write',
    schema: z
      .object({
        method: z.enum(['POST', 'PATCH', 'PUT', 'DELETE']), // P3-6: no GET
        path: z.string(),
        body: z.record(z.unknown()).optional(),
      })
      .strict(),
    handler: async (
      args: { method: string; path: string; body?: Record<string, unknown> },
      ctx: ToolContext,
    ) => {
      const body = args.body ?? {};
      const tier = classifyRisk(args.method, args.path, body);
      if (tier === 'high') {
        // INTERIM FLOOR (Phase B / threat model B7): HIGH refuses regardless of caller
        // privilege — there is deliberately NO owner/admin auto-apply path. Do NOT add a
        // caller-privilege bypass here without the approval-gate (it would put a
        // destructive cross-tenant action one prompt-injection away).
        // REFUSE high-risk WITHOUT dispatching (P3-7). High-risk routes are
        // session-only + dryRun-less, so we never attempt them — we return a
        // structured plan describing the proposed action for human review.
        // TODO(approval-gate): replace refuse with request_approval +
        // running→awaiting_approval once the PAUSE side lands (localized swap).
        return {
          refused: true,
          reason: 'high-risk action requires human approval; not applied',
          plan: { risk: tier, method: args.method, path: args.path, body },
        };
      }
      const res = await dispatchAsCaller(ctx.token, args.method, args.path, body);
      const json = await res.json().catch(() => null);
      return { status: res.status, body: json };
    },
  });
}
