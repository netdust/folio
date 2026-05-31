import { WorkspaceAgentsTab } from './workspace-agents-tab.tsx';
import { WorkspaceTriggersPage } from './workspace-triggers-page.tsx';
import { cn } from '../ui/cn.ts';

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

      <div role="tablist" className="mb-5 flex gap-1 border-b border-border-light">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={tab === t.value}
            onClick={() => onTabChange(t.value)}
            className={cn(
              '-mb-px border-b-2 px-3 py-1.5 text-sm',
              tab === t.value ? 'border-fg-1 text-fg' : 'border-transparent text-fg-3 hover:text-fg-2',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'agents' ? <WorkspaceAgentsTab wslug={wslug} /> : <WorkspaceTriggersPage wslug={wslug} />}
    </div>
  );
}
