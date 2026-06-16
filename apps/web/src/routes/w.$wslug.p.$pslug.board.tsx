import { createFileRoute, redirect } from '@tanstack/react-router';
import { DEFAULT_TABLE_SLUG } from '../lib/default-table.ts';
import { viewSearchSchema } from '../lib/table-search.ts';

// Back-compat: the legacy /board URL redirects to the unified /t/$tslug route on
// the default table. Behavior change (accepted, NocoDB model): /board no longer
// guarantees a KANBAN render — it lands on the table's active/default view. View
// type lives on the saved view, not the URL; a user who wants a board selects a
// kanban view. No synthetic kanban-pinning param — that re-couples URL to type.
// Keeps its own `viewSearchSchema` (the narrow doc+view shape it always carried);
// it is a subset of the unified target's `tableSearchSchema`, so search passes
// through unchanged.
export const Route = createFileRoute('/w/$wslug/p/$pslug/board')({
  validateSearch: viewSearchSchema,
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: '/w/$wslug/p/$pslug/t/$tslug',
      params: { ...params, tslug: DEFAULT_TABLE_SLUG },
      search,
      replace: true,
    });
  },
});
