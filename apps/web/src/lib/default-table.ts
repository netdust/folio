import { useParams } from '@tanstack/react-router';

/** Web twin of the server's seed-project-defaults.ts DEFAULT_TABLE_SLUG.
 *  The default table every project auto-seeds + the slug the no-/t/ routes resolve to. */
export const DEFAULT_TABLE_SLUG = 'work-items';

/** THE single resolver for "which table am I on". Reads the route's :tslug param
 *  when present (the /t/:tslug routes), else the default. Uses `||` (not `??`) so
 *  an empty-string param also falls back to the default — a `$tslug` segment can't
 *  normally match empty, but the guard keeps a malformed `/t//…` URL from
 *  resolving to an empty slug and hitting `/t//documents`. */
export function useCurrentTslug(): string {
  const params = useParams({ strict: false }) as { tslug?: string };
  return params.tslug || DEFAULT_TABLE_SLUG;
}
