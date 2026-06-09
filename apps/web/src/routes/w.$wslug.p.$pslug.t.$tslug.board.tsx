import { createFileRoute } from '@tanstack/react-router';
import { KanbanView } from '../components/views/kanban-view.tsx';
import { viewSearchSchema } from '../lib/table-search.ts';

// Slug-collision precedence: a user table literally slugged `board` resolves
// /t/board (this kanban route's SIBLING grid, via $tslug) and /t/board/board
// (this kanban route, via $tslug/board). TanStack treats `$tslug` and
// `$tslug/board` as distinct route ids, so both still resolve correctly — the
// literal `board` segment here always wins over `$tslug` for the deeper path.
export const Route = createFileRoute('/w/$wslug/p/$pslug/t/$tslug/board')({
  validateSearch: viewSearchSchema,
  component: BoardRoute,
});

function BoardRoute() {
  const { wslug, pslug, tslug } = Route.useParams();
  return <KanbanView wslug={wslug} pslug={pslug} tslug={tslug} />;
}
