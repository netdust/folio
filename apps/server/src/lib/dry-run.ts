import type { Context } from 'hono';

/**
 * Phase 2 (operator). The uniform preview contract for config mutations.
 *
 * `dryRun: true` on a mutating route validates + builds the would-be resource
 * and returns this envelope WITHOUT inserting or emitting any event. For
 * create/update the `resource` is the EXACT object the live (non-dryRun)
 * success branch returns as its `data` — including any wrapper key (e.g.
 * `{ view: row }`, `{ field: row }`, `{ status: row }`) — so a dryRun never
 * leaks a field the real response wouldn't and never diverges in shape
 * (mitigation P2-3). DELETE has no live body (204), so its resource is a
 * hand-picked identity snapshot. Config rows carry no secrets, so there's no
 * redaction path to diverge from.
 *
 * Two flag readers, each used consistently:
 *   - POST/PATCH: `isDryRun(c.req.valid('json'))` — reads the Zod-validated body.
 *   - DELETE:     `isDryRunDelete(c)` — reads the `?dryRun=true` query param
 *                 (DELETE carries no body schema, so a body flag can't be
 *                 validated; the web client sends no DELETE body).
 */
export type DryRunVerb = 'create' | 'update' | 'delete';

export interface DryRunEnvelope<T> {
  dry_run: true;
  would: DryRunVerb;
  resource: T;
}

export function dryRunResult<T>(would: DryRunVerb, resource: T): DryRunEnvelope<T> {
  return { dry_run: true, would, resource };
}

/**
 * Read the dryRun flag off a request whose body has already been Zod-validated
 * to carry an optional `dryRun: boolean`. Single reader so every route parses
 * the flag identically (mitigation P2-8). Defaults to false. Pass the validated
 * json object (from `c.req.valid('json')`); reading from there (not raw body)
 * means an invalid type is rejected by Zod before it reaches here.
 */
export function isDryRun(validatedJson: { dryRun?: boolean } | undefined): boolean {
  return validatedJson?.dryRun === true;
}

/**
 * Read the dryRun flag for a DELETE request. DELETE handlers carry no body
 * schema, so the flag rides the `?dryRun=true` query param. Single reader for
 * all DELETE routes (mitigation P2-8): the query parse lives in one auditable
 * place instead of being duplicated inline per route.
 */
export function isDryRunDelete(c: Context): boolean {
  return c.req.query('dryRun') === 'true';
}
