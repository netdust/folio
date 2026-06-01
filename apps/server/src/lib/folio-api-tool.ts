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
