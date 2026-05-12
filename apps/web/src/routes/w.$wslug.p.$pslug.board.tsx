import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { KanbanView } from '../components/views/kanban-view.tsx';

export const Route = createFileRoute('/w/$wslug/p/$pslug/board')({
  validateSearch: z.object({ doc: z.string().optional() }),
  component: BoardRoute,
});

function BoardRoute() {
  const { wslug, pslug } = Route.useParams();
  return <KanbanView wslug={wslug} pslug={pslug} />;
}
