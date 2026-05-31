import { useSyncExternalStore } from 'react';
import { Activity, Play } from 'lucide-react';
import { agentPanelBus, type AgentPanelScreen, type AgentPanelState } from '../../lib/agent-panel-bus.ts';
import { PanelHeader, type PanelTab } from './panel-header.tsx';
import { ActivityFeedScreen } from './activity-feed-screen.tsx';
import { AgentRunLauncher } from './agent-run-launcher.tsx';

const TABS: PanelTab<AgentPanelScreen>[] = [
  { value: 'activity', icon: Activity, label: 'Activity' },
  { value: 'run', icon: Play, label: 'Run' },
];

export function AgentCockpitPanel({ wslug }: { wslug: string }) {
  // useSyncExternalStore subscribes synchronously and re-reads the snapshot, so
  // an emit that lands in the render→effect gap on first mount (e.g. a Cmd-K
  // "Run agent…" racing the panel's mount) is never missed (no external-store
  // tearing). The bus replaces `state` with a new object per change, so the
  // snapshot identity is stable between renders (no render loop).
  const state: AgentPanelState = useSyncExternalStore(agentPanelBus.subscribe, agentPanelBus.get);
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
      </div>
    </div>
  );
}
