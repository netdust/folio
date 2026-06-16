import { createFileRoute, redirect } from '@tanstack/react-router';
import { DEFAULT_TABLE_SLUG } from '../lib/default-table.ts';
import { tableSearchSchema } from '../lib/table-search.ts';

// Back-compat: the legacy default-table URL redirects to the unified
// /t/$tslug route (Phase 6 Option B — one route per table, view type lives on
// the view). Keeps its own `tableSearchSchema` so existing bookmarked filter
// params still validate before the redirect; `tableSearchSchema` is a superset
// of the unified target's, so the search passes through unchanged.
export const Route = createFileRoute('/w/$wslug/p/$pslug/work-items')({
  validateSearch: tableSearchSchema,
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: '/w/$wslug/p/$pslug/t/$tslug',
      params: { ...params, tslug: DEFAULT_TABLE_SLUG },
      search,
      replace: true,
    });
  },
});
