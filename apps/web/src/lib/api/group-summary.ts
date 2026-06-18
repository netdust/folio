import type { AggregateSpec, GroupSummaryResponse } from '@folio/shared';
import { useQuery } from '@tanstack/react-query';
import { client } from './client.ts';

/**
 * Params for a grouped-list summary read. Mirrors the L.1 route's query
 * contract: `groupBy` (required), `aggregates` (a JSON array the route
 * JSON.parses), `filter` (an optional JSON object the route JSON.parses), and an
 * optional `type` (defaults to `work_item` server-side).
 */
export interface GroupSummaryParams {
  groupBy: string;
  aggregates: AggregateSpec[];
  filter?: Record<string, unknown>;
  type?: 'work_item' | 'page';
}

/**
 * Build the table-scoped group-summary URL. The L.1 route reads
 * `c.req.query('groupBy')`, `JSON.parse(c.req.query('aggregates'))`, and
 * `JSON.parse(c.req.query('filter'))`, so `aggregates`/`filter` MUST be
 * `JSON.stringify`-then-URL-encoded. URLSearchParams handles the percent-encoding
 * (it encodes the JSON braces/quotes the same way the route's decode expects).
 *
 * Exported pure so the serialization contract is unit-testable without rendering
 * the hook — a wrong serialization silently mis-aggregates (the Tier-A risk).
 */
export function groupSummaryPath(
  wslug: string,
  pslug: string,
  tslug: string,
  params: GroupSummaryParams,
): string {
  const sp = new URLSearchParams();
  sp.set('groupBy', params.groupBy);
  sp.set('aggregates', JSON.stringify(params.aggregates));
  if (params.filter && Object.keys(params.filter).length > 0) {
    sp.set('filter', JSON.stringify(params.filter));
  }
  sp.set('type', params.type ?? 'work_item');
  return `/api/v1/w/${wslug}/p/${pslug}/t/${tslug}/documents/group-summary?${sp.toString()}`;
}

/**
 * Read the per-group summary for a table's grouped-list view.
 *
 * Keyed on a DISTINCT `group-summary` namespace — deliberately NOT nested under
 * `documentsKeys` / `entityKeys.all`. A prefix invalidation under the shared
 * documents prefix would remount this seed query mid-flow even with a long
 * staleTime (the "prefix-invalidation ignores staleTime" hazard); the distinct
 * namespace keeps it out of that blast radius.
 */
export function useGroupSummary(
  wslug: string,
  pslug: string,
  tslug: string,
  params: GroupSummaryParams,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: [
      'group-summary',
      wslug,
      pslug,
      tslug,
      params.groupBy,
      JSON.stringify(params.aggregates),
      JSON.stringify(params.filter ?? null),
      params.type ?? 'work_item',
    ] as const,
    queryFn: () => client.get<GroupSummaryResponse>(groupSummaryPath(wslug, pslug, tslug, params)),
    staleTime: 30_000,
    enabled:
      !!wslug &&
      !!pslug &&
      !!tslug &&
      !!params.groupBy &&
      params.aggregates.length > 0 &&
      (options.enabled ?? true),
  });
}
