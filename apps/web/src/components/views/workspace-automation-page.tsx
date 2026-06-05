import { WorkspaceAgentsTab } from './workspace-agents-tab.tsx';
import { WorkspaceTriggersPage } from './workspace-triggers-page.tsx';
import { TokensTab } from '../settings/tokens-tab.tsx';
import { useWorkspace } from '../../lib/api/workspaces.ts';
import { Tabs } from '../ui/tabs.tsx';

export type AutomationTab = 'agents' | 'triggers' | 'api';

interface Props {
  wslug: string;
  tab: AutomationTab;
  onTabChange: (tab: AutomationTab) => void;
}

const TABS: { value: AutomationTab; label: string }[] = [
  { value: 'agents', label: 'Agents' },
  { value: 'triggers', label: 'Triggers' },
  { value: 'api', label: 'API' },
];

/**
 * Workspace automation page: Agents + Triggers + API tokens, all workspace-scoped
 * and all about agent/integration access, under one destination with three tabs.
 * Editing an agent/trigger opens the layout-mounted config slideover via ?wdoc=.
 * Management lives here; interaction (giving an agent work) lives in the cockpit
 * panel. API tokens authenticate the agents / MCP clients / external integrations
 * that act on this workspace — so they sit with the things that use them (the
 * standalone Workspace-settings page that used to hold them was removed).
 */
export function WorkspaceAutomationPage({ wslug, tab, onTabChange }: Props) {
  const workspace = useWorkspace(wslug);

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-lg font-medium tracking-tight">Agents &amp; Triggers</h1>
        <p className="mt-0.5 text-xs text-fg-2">
          Workspace-scoped agents, the cron/event triggers that fire them, and the
          API tokens that authenticate agents &amp; integrations against this workspace.
        </p>
      </header>

      <div className="mb-5">
        <Tabs value={tab} onChange={onTabChange} items={TABS} />
      </div>

      {tab === 'agents' ? (
        <WorkspaceAgentsTab wslug={wslug} />
      ) : tab === 'triggers' ? (
        <WorkspaceTriggersPage wslug={wslug} />
      ) : workspace.data ? (
        <TokensTab wslug={wslug} workspaceId={workspace.data.id} />
      ) : null}
    </div>
  );
}
