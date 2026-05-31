import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';
import { useWorkspace } from '../lib/api/workspaces.ts';
import { TokensTab } from '../components/settings/tokens-tab.tsx';
import { AiTab } from '../components/settings/ai-tab.tsx';
import { Tabs } from '../components/ui/tabs.tsx';

const settingsSearchSchema = z.object({
  // Deep-link target tab. The provider-health banner's "Check key →" lands on
  // the AI tab via `?tab=ai`.
  tab: z.enum(['tokens', 'ai']).optional(),
  // The degraded provider name, carried for a future per-provider preselect.
  // AiTab owns its own provider state today, so this is read but not yet wired
  // (preselect deferred — see RouteComponent).
  provider: z.string().optional(),
});

export const Route = createFileRoute('/w/$wslug/settings')({
  validateSearch: settingsSearchSchema,
  component: RouteComponent,
});

function RouteComponent() {
  const { wslug } = Route.useParams();
  const { tab } = Route.useSearch();
  // `provider` is intentionally not forwarded: AiTab manages its own provider
  // selection internally and exposes no `provider` prop, so landing on the AI
  // tab is the v1 contract. Per-provider preselect is deferred until AiTab
  // accepts an external selection.
  return <SettingsPage wslug={wslug} initialTab={tab} />;
}

type TabKey = 'tokens' | 'ai';

export function SettingsPage({ wslug, initialTab }: { wslug: string; initialTab?: TabKey }) {
  const workspace = useWorkspace(wslug);
  const [tab, setTab] = useState<TabKey>(initialTab ?? 'tokens');

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
