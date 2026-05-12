import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/w/$wslug/p/$pslug/wiki')({
  component: WikiRoute,
});

function WikiRoute() {
  return <div className="p-4 text-fg-3">Wiki tree — built in Task 25.</div>;
}
