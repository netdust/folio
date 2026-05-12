import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

export const Route = createFileRoute('/w/$wslug/p/$pslug/board')({
  validateSearch: z.object({ doc: z.string().optional() }),
  component: BoardRoute,
});

function BoardRoute() {
  return <div className="p-4 text-fg-3">Kanban board — built in Task 23.</div>;
}
