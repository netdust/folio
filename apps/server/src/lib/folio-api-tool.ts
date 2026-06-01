/**
 * folio_api / folio_api_get — operator-agent in-process REST bridge.
 *
 * Ground-truth recorded for later Phase-op-3 tasks (verified 2026-06-02 on
 * branch phase-op-3/the-agent — do not trust blindly, re-confirm if stale):
 *
 *  - `listDocuments(opts: ListDocumentsOptions): Promise<{ data: Document[];
 *    nextCursor: string | null }>` lives at apps/server/src/services/documents.ts:201.
 *    Its options interface `ListDocumentsOptions` is at line 179 (projectId,
 *    type?, limit?, cursor?, filter?, statusValues?, assignee?, titleQuery?,
 *    updatedSince?, staleFor?, sort?, dir?, activeTableId?). NO `includeSystem`
 *    field yet — a later task adds it for the folio_system filter.
 *  - `json_extract` is ALREADY used in services/documents.ts (lines 121/123/133/
 *    139/271). The later folio_system frontmatter filter should match this house
 *    style (e.g. json_extract(documents.frontmatter, '$.folio_system')).
 *  - Seed helpers (used by later tasks, not this one):
 *      seedBuiltinTriggers — apps/server/src/lib/builtin-triggers.ts:106
 *      seedProjectDefaults — apps/server/src/lib/seed-project-defaults.ts:7
 *  - `app` is exported at apps/server/src/app.ts:34
 *    (`export const app = new Hono<AuthContext & ScopeContext>()`). Later tasks
 *    import it into lib/ to dispatch in-process; if a static import cycles,
 *    lazy-import inside the handler: `const { app } = await import('../app.ts')`.
 *    Task 1 does NOT import app.
 */

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
 *  1. HIGH  — permission/membership routes, workspace-level deletion, explicit bulk.
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
  // 1. High: permission/membership, workspace-level destruction, or explicit bulk.
  if (/\/members?(\/|$)/.test(path)) return 'high';
  if (method === 'DELETE' && /^\/api\/v1\/w\/[^/]+$/.test(path)) return 'high'; // workspace delete
  if (body && body.bulk === true) return 'high';

  // 2. Medium: structure/config writes.
  if (/\/(tables|fields|views|statuses)(\/|$)/.test(path)) return 'medium';
  // Project config: the projects collection / project item (real route shape),
  // OR the bare /p/:slug terminus (plan spec shape). Anchored to end-of-path so
  // sub-resources like /p/:slug/documents fall through to low.
  if (
    method !== 'GET' &&
    (/^\/api\/v1\/w\/[^/]+\/projects(\/[^/]+)?$/.test(path) ||
      /^\/api\/v1\/w\/[^/]+\/p\/[^/]+$/.test(path))
  ) {
    return 'medium';
  }

  // 3. Low: document writes + everything else token-scoped.
  return 'low';
}
