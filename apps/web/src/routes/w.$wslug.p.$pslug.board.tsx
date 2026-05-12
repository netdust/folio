import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/w/$wslug/p/$pslug/board')({
  component: BoardRoute,
});

function BoardRoute() {
  return <div className="p-4 text-fg-3">Kanban board — built in Task 23.</div>;
}
