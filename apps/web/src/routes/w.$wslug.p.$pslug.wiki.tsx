import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

export const Route = createFileRoute('/w/$wslug/p/$pslug/wiki')({
  validateSearch: z.object({ doc: z.string().optional() }),
  component: WikiRoute,
});

function WikiRoute() {
  return <div className="p-4 text-fg-3">Wiki tree — built in Task 25.</div>;
}
