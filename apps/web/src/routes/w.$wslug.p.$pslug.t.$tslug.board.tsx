import { createFileRoute, redirect } from '@tanstack/react-router';
import { viewSearchSchema } from '../lib/table-search.ts';

// Back-compat: the legacy /t/$tslug/board URL redirects to the unified
// /t/$tslug route on the SAME table (params — incl. the real $tslug — pass
// straight through). View type now lives on the saved view, not the URL; a
// user who wants a board selects a kanban view. Keeps its own
// `viewSearchSchema` (the narrow doc+view shape it always carried), a subset of
// the unified target's `tableSearchSchema`, so search passes through unchanged.
export const Route = createFileRoute('/w/$wslug/p/$pslug/t/$tslug/board')({
  validateSearch: viewSearchSchema,
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: '/w/$wslug/p/$pslug/t/$tslug',
      params,
      search,
      replace: true,
    });
  },
});
