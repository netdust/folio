import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { z } from 'zod';
import { SYSTEM_WORKSPACE_SLUG, useWorkspace } from '../lib/api/workspaces.ts';
import { useIsSystemMember } from '../lib/api/auth.ts';
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
  const isSystemMember = useIsSystemMember();
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

      {/*
        D2: System Library entry, gated on `__system` membership. It's a link
        SECTION, not a third tab, because it NAVIGATES to the existing
        per-workspace agents/automation surface pointed at `__system` rather
        than rendering tab content here — a tab that immediately navigates away
        is worse UX than a clearly-labeled link. Rendered below the tabs so it's
        always visible to a member regardless of which tab is active.

        FOLLOW-UP: this is an instance-level surface temporarily living in
        per-workspace settings. Move it to a global/account settings surface
        when one lands. No new management UI is built — Skills/Reference docs are
        reachable via the `__system` workspace's wiki/document views.
      */}
      {isSystemMember ? (
        <section className="mt-8 rounded-md border border-border-light bg-shell p-4">
          <h2 className="text-sm font-medium">System Library</h2>
          <p className="mt-0.5 text-xs text-fg-2">
            Curate the shared library agents and triggers that any workspace can
            run. Opens the {SYSTEM_WORKSPACE_SLUG} workspace's automation page.
          </p>
          <Link
            to="/w/$wslug/agents"
            params={{ wslug: SYSTEM_WORKSPACE_SLUG }}
            className="mt-3 inline-block text-sm text-fg-2 hover:text-fg"
          >
            Open System Library →
          </Link>
        </section>
      ) : null}
    </div>
  );
}
