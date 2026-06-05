import { createFileRoute } from '@tanstack/react-router';
import { useWorkspace } from '../lib/api/workspaces.ts';
import { TokensTab } from '../components/settings/tokens-tab.tsx';

export const Route = createFileRoute('/w/$wslug/settings')({
  component: RouteComponent,
});

function RouteComponent() {
  const { wslug } = Route.useParams();
  return <SettingsPage wslug={wslug} />;
}

// Workspace-scoped settings. AI keys moved to the instance /settings page; the
// only workspace setting today is API tokens, so this renders TokensTab directly
// (a single-tab Tabs wrapper was dead UI — removed).
export function SettingsPage({ wslug }: { wslug: string }) {
  const workspace = useWorkspace(wslug);

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <div className="text-[10px] uppercase tracking-wide text-fg-3">
          {workspace.data?.name ?? ''}
        </div>
        <h1 className="text-lg font-medium tracking-tight">Workspace settings</h1>
        <p className="mt-1 text-xs text-fg-2">API tokens for this workspace.</p>
      </header>

      {workspace.data ? <TokensTab wslug={wslug} workspaceId={workspace.data.id} /> : null}
    </div>
  );
}
