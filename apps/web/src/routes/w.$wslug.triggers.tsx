import { createFileRoute, redirect } from '@tanstack/react-router';
import { z } from 'zod';

// Legacy /triggers route. Triggers now live under /agents?tab=triggers; the
// trigger config slideover still opens via ?wdoc=. validateSearch parses the
// incoming wdoc so a deep link like /w/X/triggers?wdoc=some-trigger survives
// the redirect and lands on the Triggers tab with the slideover open.
export const Route = createFileRoute('/w/$wslug/triggers')({
  validateSearch: z.object({ wdoc: z.string().optional() }),
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: '/w/$wslug/agents',
      params: { wslug: params.wslug },
      search: { tab: 'triggers', ...(search.wdoc ? { wdoc: search.wdoc } : {}) },
    });
  },
});
