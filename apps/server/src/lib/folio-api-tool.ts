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
import { ADMIN_SCOPES } from './agent-schema.ts'; // CR#3: derive the C3 config floor
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

export type ScopeTarget = string | 'SECRET' | 'UNMAPPED' | null;

/**
 * A document/comment/run write lives under the documents|comments|runs route
 * mount, whose TRAILING segment is an arbitrary user SLUG (or run id) that can
 * equal a config/secret route keyword ('tokens','ai-keys','members','settings',
 * 'tables',...). The keyword checks below match a keyword ANYWHERE in the path,
 * so a document slugged 'tokens' at `/documents/tokens` would otherwise be
 * mis-classified SECRET and permanently refused (CR#1, fail-closed bug).
 *
 * This anchor matches the documents|comments|runs keyword only where the REAL
 * route mounts produce it — directly under `/w/<ws>`, or under `/w/<ws>/p/<proj>`,
 * or under `/w/<ws>/p/<proj>/t/<tslug>` (verified against app.ts mounts:
 * wScope `/documents` + `/runs`, pScope `/documents`+`/comments`+`/runs`,
 * tScope `/t/:tslug/documents`). A doc slug is a single `[^/]+` segment and so
 * can never inject a fake `documents/` deeper in the path. Classify this
 * sub-resource FIRST so its trailing slug never reaches the keyword branches.
 */
const DOC_SUBRESOURCE =
  /^\/api\/v1\/w\/[^/]+(?:\/p\/[^/]+(?:\/t\/[^/]+)?)?\/(documents|comments|runs)(\/|$)/;

/** Secret-class writes: never grantable to any token (T6). */
export function isSecretWrite(method: string, path: string): boolean {
  if (method.toUpperCase() === 'GET') return false;
  // A document slugged 'tokens'/'ai-keys' is NOT a secret route — exclude the
  // documents/comments/runs sub-resource before matching the secret keywords (CR#1).
  if (DOC_SUBRESOURCE.test(path)) return false;
  return /\/tokens(\/|$)/.test(path) || /\/ai-keys(\/|$)/.test(path);
}

/**
 * Config-class scopes — these refuse on an UNATTENDED run (C3 floor).
 * CR#3: derived from ADMIN_SCOPES so a NEW admin scope is floored by
 * construction, not by remembering to edit a hand-typed list. The resulting set
 * equals {config:write, settings:write, members:write, workspace:admin}.
 */
const CONFIG_CLASS_SCOPES = new Set<string>(['config:write', ...ADMIN_SCOPES]);

/**
 * Map a write to its required scope. Reads (GET) → null (gated elsewhere by the
 * token's documents:read). Secret writes → 'SECRET' (always refused, T6). A
 * write path with NO mapping → 'UNMAPPED' (handler refuses — default-deny, T5).
 * Every NEW write route MUST add a branch here or it fails closed.
 *
 * NOTE (CR#8): this map is a fail-closed PRE-CHECK only. The dispatched route's
 * own requireScope/requireSessionUser (run via app.request in dispatchAsCaller)
 * is the authoritative gate. The members:write and settings:write branches here
 * are DEFENSIVE, not authoritative — no agent-writable route currently uses
 * them (members has no write route, only GET /members; AI-key writes are
 * session-only + __system-admin-gated at /instance/ai-keys, which is also
 * SECRET-classified and unreachable by any agent token). They
 * stay so any future workspace-level path that DID land there fails closed to
 * the right scope rather than UNMAPPED.
 *
 * Order matters: documents/comments/runs FIRST (CR#1 — their trailing slug is
 * arbitrary and must never be matched by the config/secret keyword branches),
 * then secret, workspace-terminus, members, settings, structure-config, project
 * collection/item, then UNMAPPED.
 */
export function pathToScope(method: string, path: string): ScopeTarget {
  const m = method.toUpperCase();
  if (m === 'GET') return null;
  // CR#1: documents/comments/runs first — their trailing slug is arbitrary and
  // must never be matched by the config/secret keyword branches below.
  if (DOC_SUBRESOURCE.test(path)) return 'documents:write';
  if (isSecretWrite(m, path)) return 'SECRET';
  if (/^\/api\/v1\/w\/[^/]+$/.test(path)) return 'workspace:admin'; // rename/delete workspace
  if (/^\/api\/v1\/w\/[^/]+\/members?(\/|$)/.test(path)) return 'members:write';
  if (/^\/api\/v1\/w\/[^/]+\/settings(\/|$)/.test(path)) return 'settings:write';
  if (/^\/api\/v1\/w\/[^/]+\/p\/[^/]+(?:\/t\/[^/]+)?\/(tables|fields|views|statuses)(\/|$)/.test(path))
    return 'config:write';
  if (/^\/api\/v1\/w\/[^/]+\/projects(\/[^/]+)?$/.test(path)) return 'config:write';
  if (/^\/api\/v1\/w\/[^/]+\/p\/[^/]+$/.test(path)) return 'config:write'; // bare project item
  return 'UNMAPPED';
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
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative /api/v1/... path to GET.' },
      },
      required: ['path'],
    },
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
      'Each write path maps to a required scope; secret-class writes (tokens/ai-keys) and unmapped ' +
      'paths are never applied — the proposed plan is returned instead. Use folio_api_get for reads.',
    requiredScope: 'config:write',
    schema: z
      .object({
        method: z.enum(['POST', 'PATCH', 'PUT', 'DELETE']), // P3-6: no GET
        path: z.string(),
        body: z.record(z.unknown()).optional(),
      })
      .strict(),
    inputSchema: {
      type: 'object',
      properties: {
        method: {
          type: 'string',
          enum: ['POST', 'PATCH', 'PUT', 'DELETE'],
          description: 'Write method. GET is not allowed — use folio_api_get for reads.',
        },
        path: { type: 'string', description: 'Relative /api/v1/... path to write.' },
        body: { type: 'object', description: 'Request body.' },
      },
      required: ['method', 'path'],
    },
    handler: async (
      args: { method: string; path: string; body?: Record<string, unknown> },
      ctx: ToolContext,
    ) => {
      const body = args.body ?? {};
      // Single refuse-with-plan envelope (CR cleanup) — every gate below returns
      // the SAME shape, so a future change to the contract (e.g. add a field the
      // cockpit UI keys on) lands in one place, not four.
      const refuse = (reason: string) => ({
        refused: true,
        reason,
        plan: { method: args.method, path: args.path, body },
      });
      const scopeTarget = pathToScope(args.method, args.path);
      // T5 default-deny: an unmapped write path is refused by construction. Every
      // NEW write route must add a branch to pathToScope or it fails closed here.
      if (scopeTarget === 'UNMAPPED') {
        return refuse('no scope mapping for this write path; refused');
      }
      // T6 secret-refuse: tokens/ai-keys writes are NEVER applied by an agent —
      // for EVERY token, including a full-scope instance bearer. No bypass.
      if (scopeTarget === 'SECRET') {
        return refuse('secret-class write (tokens/ai-keys) is never applied by an agent');
      }
      // T-scope double-gate (agent ∩ caller): the run token AND the caller must
      // both hold the mapped scope. Missing on either → refuse.
      if (
        scopeTarget !== null &&
        (!ctx.token.scopes.includes(scopeTarget) || !ctx.callerScopes.includes(scopeTarget))
      ) {
        return refuse(`missing scope ${scopeTarget}; refused`);
      }
      // C3 unattended config floor — DETERMINISTIC bound on the unattended
      // injection chain: a trigger-fired (no-human) run cannot do config-class
      // writes, refuse-with-plan regardless of scope possession. Document writes
      // (documents:write) stay allowed unattended (the B10 fence is best-effort
      // for LOW only). Secret writes already refuse for everyone above.
      if (ctx.unattended === true && scopeTarget !== null && CONFIG_CLASS_SCOPES.has(scopeTarget)) {
        return refuse(
          `config-class write (${scopeTarget}) refused on an unattended (trigger-fired) run; not applied`,
        );
      }
      const res = await dispatchAsCaller(ctx.token, args.method, args.path, body);
      const json = await res.json().catch(() => null);
      return { status: res.status, body: json };
    },
  });
}
