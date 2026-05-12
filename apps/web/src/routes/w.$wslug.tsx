import { createFileRoute, Outlet, useNavigate } from '@tanstack/react-router';
import { useWorkspace } from '../lib/api/workspaces.ts';

export const Route = createFileRoute('/w/$wslug')({
  component: WorkspaceLayout,
});

function WorkspaceLayout() {
  const { wslug } = Route.useParams();
  const { data: workspace, isPending, isError } = useWorkspace(wslug);
  const navigate = useNavigate();

  if (isPending) {
    return (
      <div className="flex h-screen items-center justify-center bg-shell">
        <p className="text-fg-3">Loading…</p>
      </div>
    );
  }

  if (isError || !workspace) {
    return (
      <div className="flex h-screen items-center justify-center bg-shell">
        <p className="text-danger">Workspace not found.</p>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-shell">
      {/* Rail placeholder — wired in Task 8 */}
      <aside className="flex w-[200px] flex-col rounded-xl bg-content shadow-surface px-3 py-3.5 m-1.5">
        <div className="flex items-center gap-2.5 px-2 mb-2">
          <span className="inline-grid h-7 w-7 place-items-center rounded bg-primary text-primary-fg text-sm font-semibold tracking-tight">
            F
          </span>
          <span className="text-sm font-medium tracking-tight">Folio</span>
        </div>
        <button
          type="button"
          onClick={() => void navigate({ to: '/' })}
          className="flex items-center gap-2.5 rounded-md px-2 py-1.5 mb-2 hover:bg-card transition-colors duration-fast"
        >
          <span className="inline-grid h-[22px] w-[22px] place-items-center rounded bg-primary text-primary-fg text-[11px] font-semibold">
            {workspace.name.slice(0, 2).toUpperCase()}
          </span>
          <span className="text-sm font-medium flex-1 text-left truncate">{workspace.name}</span>
          <span className="text-fg-3 text-[11px]">▾</span>
        </button>
      </aside>
      {/* Main content */}
      <div className="flex-1 min-w-0 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}
