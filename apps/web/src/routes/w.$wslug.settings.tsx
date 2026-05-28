import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useWorkspace } from '../lib/api/workspaces.ts';
import { TokensTab } from '../components/settings/tokens-tab.tsx';
import { AiTab } from '../components/settings/ai-tab.tsx';
import { Tabs } from '../components/ui/tabs.tsx';

export const Route = createFileRoute('/w/$wslug/settings')({
  component: RouteComponent,
});

function RouteComponent() {
  const { wslug } = Route.useParams();
  return <SettingsPage wslug={wslug} />;
}

type TabKey = 'tokens' | 'ai';

export function SettingsPage({ wslug }: { wslug: string }) {
  const workspace = useWorkspace(wslug);
  const [tab, setTab] = useState<TabKey>('tokens');

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
          value={tab}
          onChange={setTab}
          items={[
            { value: 'tokens', label: 'API tokens' },
            { value: 'ai', label: 'AI' },
          ]}
        />
      </div>

      {tab === 'tokens' && workspace.data ? (
        <TokensTab wslug={wslug} workspaceId={workspace.data.id} />
      ) : null}
      {tab === 'ai' && workspace.data ? (
        <AiTab wslug={wslug} workspaceId={workspace.data.id} />
      ) : null}
    </div>
  );
}
