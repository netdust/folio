import { useEffect, useState } from 'react';
import { Activity, Bot, Play } from 'lucide-react';
import { agentPanelBus, type AgentPanelScreen, type AgentPanelState } from '../../lib/agent-panel-bus.ts';
import { PanelHeader, type PanelTab } from './panel-header.tsx';
import { ActivityFeedScreen } from './activity-feed-screen.tsx';
import { AgentRunLauncher } from './agent-run-launcher.tsx';
import { AgentList } from './agent-list.tsx';

const TABS: PanelTab<AgentPanelScreen>[] = [
  { value: 'activity', icon: Activity, label: 'Activity' },
  { value: 'run', icon: Play, label: 'Run' },
  { value: 'agents', icon: Bot, label: 'Agents' },
];

export function AgentCockpitPanel({ wslug }: { wslug: string }) {
  const [state, setState] = useState<AgentPanelState>(() => agentPanelBus.get());
  useEffect(() => agentPanelBus.subscribe(setState), []);
  if (!state.open) return null;
  const setScreen = (screen: AgentPanelScreen) => agentPanelBus.open(screen);
  return (
    <div className="flex w-[360px] shrink-0 flex-col rounded-md border border-border-light bg-content">
      <PanelHeader
        title="Agents"
        tabs={TABS}
        active={state.screen}
        onTab={setScreen}
        onClose={() => agentPanelBus.close()}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {state.screen === 'activity' ? <ActivityFeedScreen wslug={wslug} /> : null}
        {state.screen === 'run' ? (
          <AgentRunLauncher wslug={wslug} onLaunched={() => agentPanelBus.open('activity')} />
        ) : null}
        {state.screen === 'agents' ? <AgentList wslug={wslug} /> : null}
      </div>
    </div>
  );
}
