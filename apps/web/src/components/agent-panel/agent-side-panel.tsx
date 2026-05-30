import { useEffect, useState } from 'react';
import { agentPanelBus, type AgentPanelTab } from '../../lib/agent-panel-bus.ts';
import { PanelHeader, type PanelTab } from './panel-header.tsx';
import { AgentRunLauncher } from './agent-run-launcher.tsx';
import { ActivityFeedScreen } from './activity-feed-screen.tsx';

const TABS: PanelTab<AgentPanelTab>[] = [
  { value: 'run', icon: '▶', label: 'Run' },
  { value: 'activity', icon: '⚡', label: 'Activity' },
];

interface AgentSidePanelProps {
  wslug: string;
}

export function AgentSidePanel({ wslug }: AgentSidePanelProps) {
  const [{ open, tab }, setState] = useState(agentPanelBus.get());

  useEffect(() => {
    setState(agentPanelBus.get());
    return agentPanelBus.subscribe(setState);
  }, []);

  if (!open) return null;

  const setTab = (t: AgentPanelTab) => setState((s) => ({ ...s, tab: t }));

  return (
    <div className="flex w-[360px] shrink-0 flex-col rounded-md border border-border-light bg-content">
      <PanelHeader
        title="Agents"
        tabs={TABS}
        active={tab}
        onTab={setTab}
        onClose={() => agentPanelBus.close()}
      />
      {tab === 'run' ? (
        <AgentRunLauncher wslug={wslug} onLaunched={() => setTab('activity')} />
      ) : (
        <ActivityFeedScreen wslug={wslug} />
      )}
    </div>
  );
}
