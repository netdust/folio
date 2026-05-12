import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/w/$wslug/p/$pslug/work-items')({
  component: WorkItemsRoute,
});

function WorkItemsRoute() {
  // Real list view lands in Task 10.
  return <div className="p-4 text-fg-3">Work items list — built in Task 10.</div>;
}
