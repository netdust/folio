import { createFileRoute } from '@tanstack/react-router';
import { KanbanView } from '../components/views/kanban-view.tsx';
import { DEFAULT_TABLE_SLUG } from '../lib/default-table.ts';
import { viewSearchSchema } from '../lib/table-search.ts';

export const Route = createFileRoute('/w/$wslug/p/$pslug/board')({
  validateSearch: viewSearchSchema,
  component: BoardRoute,
});

function BoardRoute() {
  const { wslug, pslug } = Route.useParams();
  return <KanbanView wslug={wslug} pslug={pslug} tslug={DEFAULT_TABLE_SLUG} />;
}
