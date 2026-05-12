import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/w/$wslug/')({
  component: WorkspaceIndexPage,
});

function WorkspaceIndexPage() {
  // Project picker — implemented in Task 8.
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-fg-3">Select or create a project.</p>
    </div>
  );
}
