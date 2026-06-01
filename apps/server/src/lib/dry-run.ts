/**
 * Phase 2 (operator). The uniform preview contract for config mutations.
 *
 * `dryRun: true` on a mutating route validates + builds the would-be resource
 * and returns this envelope WITHOUT inserting or emitting any event. The
 * `resource` is the EXACT object the live (non-dryRun) success branch returns,
 * so a dryRun never leaks a field the real response wouldn't (mitigation P2-3).
 * Config rows carry no secrets, so there's no redaction path to diverge from.
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
