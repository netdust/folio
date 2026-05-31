import { WorkspaceAgentsTab } from './workspace-agents-tab.tsx';
import { WorkspaceTriggersPage } from './workspace-triggers-page.tsx';
import { Tabs } from '../ui/tabs.tsx';

export type AutomationTab = 'agents' | 'triggers';

interface Props {
  wslug: string;
  tab: AutomationTab;
  onTabChange: (tab: AutomationTab) => void;
}

const TABS: { value: AutomationTab; label: string }[] = [
  { value: 'agents', label: 'Agents' },
  { value: 'triggers', label: 'Triggers' },
];

/**
 * Workspace automation page: Agents + Triggers, both workspace-scoped documents,
 * under one destination with two tabs. Editing either opens the layout-mounted
 * config slideover via ?wdoc=. Management lives here; interaction (giving an
 * agent work) lives in the cockpit panel.
 */
export function WorkspaceAutomationPage({ wslug, tab, onTabChange }: Props) {
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6">
        <h1 className="text-lg font-medium tracking-tight">Agents &amp; Triggers</h1>
        <p className="mt-0.5 text-xs text-fg-2">
          Workspace-scoped agents and the cron/event triggers that fire them.
        </p>
      </header>

      <div className="mb-5">
        <Tabs value={tab} onChange={onTabChange} items={TABS} />
      </div>

      {tab === 'agents' ? <WorkspaceAgentsTab wslug={wslug} /> : <WorkspaceTriggersPage wslug={wslug} />}
    </div>
  );
}
