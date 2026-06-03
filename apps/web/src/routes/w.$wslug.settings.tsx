import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { useWorkspace } from '../lib/api/workspaces.ts';
import { TokensTab } from '../components/settings/tokens-tab.tsx';
import { Tabs } from '../components/ui/tabs.tsx';

const settingsSearchSchema = z.object({
  // Deep-link target tab. AI keys moved to the instance settings page (/settings);
  // this page is workspace-scoped settings only (API tokens today).
  tab: z.enum(['tokens']).optional(),
});

export const Route = createFileRoute('/w/$wslug/settings')({
  validateSearch: settingsSearchSchema,
  component: RouteComponent,
});

function RouteComponent() {
  const { wslug } = Route.useParams();
  const { tab } = Route.useSearch();
  return <SettingsPage wslug={wslug} initialTab={tab} />;
}

type TabKey = 'tokens';

export function SettingsPage({ wslug, initialTab }: { wslug: string; initialTab?: TabKey }) {
  const workspace = useWorkspace(wslug);

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <div className="text-[10px] uppercase tracking-wide text-fg-3">
          {workspace.data?.name ?? ''}
        </div>
        <h1 className="text-lg font-medium tracking-tight">Workspace settings</h1>
      </header>

      <div className="mb-5">
        <Tabs<TabKey>
          value={initialTab ?? 'tokens'}
          onChange={() => {}}
          items={[{ value: 'tokens', label: 'API tokens' }]}
        />
      </div>

      {workspace.data ? <TokensTab wslug={wslug} workspaceId={workspace.data.id} /> : null}
    </div>
  );
}
