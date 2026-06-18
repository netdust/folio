import {
  ChevronDown,
  Clock,
  History,
  MessagesSquare,
  MoreHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { type AgentPanelState, agentPanelBus } from '../../lib/agent-panel-bus.ts';
import { useRecentConversation } from '../../lib/api/conversations.ts';
import { useWorkspace } from '../../lib/api/workspaces.ts';
import { cn } from '../ui/cn.ts';
import { Icon } from '../ui/icon.tsx';
import { CockpitChat, type CockpitThreadState } from './cockpit-chat.tsx';

/**
 * The layout-level operator cockpit panel. Renders the operator CHAT plus its
 * chrome: a status header, a model-selector + Ask/Auto control row, and the
 * Chat / Activity / History tab bar. Open/closed is driven by `agentPanelBus`
 * (default-open, respect-last-closed). It is a panel, NOT a modal: the main area
 * stays interactive behind it and a link_panel click navigates the main area
 * without closing the cockpit.
 *
 * What's WIRED vs. COSMETIC (this pass):
 *   - Header status (Connected · {workspace} / Working…): wired to the live
 *     thread `busy` lifted from CockpitChat, and the current workspace name.
 *   - Tabs: Chat is the live conversation; Activity shows the thread's tool
 *     steps (same data, no extra fetch) with a count badge; History is a
 *     placeholder — there is no list-conversations endpoint yet (TODO).
 *   - Model selector ("Operator Pro") + Ask/Auto toggle: COSMETIC. The operator
 *     model is instance-level (no per-conversation selector) and there is no
 *     approval-mode backend; single-active-turn is server-enforced. Rendered to
 *     match the design; Ask/Auto is local state only (TODO: wire when an
 *     approval mode exists).
 *
 * useSyncExternalStore subscribes synchronously and re-reads the snapshot, so an
 * emit that lands in the render→effect gap on first mount is never missed (no
 * external-store tearing); the bus replaces `state` per change so the snapshot
 * identity is stable between renders (no render loop).
 */

type CockpitTab = 'chat' | 'activity' | 'history';
type RunMode = 'ask' | 'auto';

const MODEL_LABEL = 'Operator Pro';

export function AgentCockpitPanel({ wslug }: { wslug?: string }) {
  const state: AgentPanelState = useSyncExternalStore(agentPanelBus.subscribe, agentPanelBus.get);
  const { recentId, loaded } = useRecentConversation();
  const { data: workspace } = useWorkspace(wslug ?? '');

  const [tab, setTab] = useState<CockpitTab>('chat');
  // COSMETIC (no approval-mode backend yet). Default Auto to match the design.
  const [mode, setMode] = useState<RunMode>('auto');
  const [threadState, setThreadState] = useState<CockpitThreadState>({
    busy: false,
    toolStepCount: 0,
  });

  if (!state.open) return null;

  const workspaceName = workspace?.name ?? wslug ?? 'workspace';
  const modeLabel = mode === 'auto' ? 'Auto-run mode' : 'Ask-first mode';

  return (
    <div className="flex w-[360px] shrink-0 flex-col rounded-md border border-border-light bg-content">
      {/* Header: avatar + title + live status, edit/overflow/close actions */}
      <div className="flex items-start gap-2.5 border-b border-border-light px-3 py-2.5">
        <div
          className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-fg"
          aria-hidden="true"
        >
          <Icon icon={Sparkles} size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-fg">Operator</div>
          <div className="flex items-center gap-1.5 text-[11px] text-fg-2">
            <span
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                threadState.busy ? 'animate-pulse bg-warning' : 'bg-success',
              )}
              aria-hidden="true"
            />
            <span className="truncate">
              {threadState.busy ? 'Working' : 'Connected'} · {workspaceName}
            </span>
          </div>
        </div>
        <button
          type="button"
          aria-label="More"
          className="grid size-6 shrink-0 place-items-center rounded text-fg-3 hover:bg-card hover:text-fg"
        >
          <Icon icon={MoreHorizontal} size={16} />
        </button>
        <button
          type="button"
          aria-label="Close"
          onClick={() => agentPanelBus.close()}
          className="grid size-6 shrink-0 place-items-center rounded text-fg-3 hover:bg-card hover:text-fg"
        >
          <Icon icon={X} size={16} />
        </button>
      </div>

      {/* Control row: model selector (cosmetic) + Ask/Auto toggle (cosmetic) */}
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md border border-border-light bg-card px-2.5 py-1 text-xs font-medium text-fg hover:bg-brand-2"
          // TODO: open a model picker when per-conversation model selection exists.
        >
          <Icon icon={Sparkles} size={14} className="text-fg-2" />
          {MODEL_LABEL}
          <Icon icon={ChevronDown} size={14} className="text-fg-3" />
        </button>
        <div className="flex items-center rounded-md border border-border-light bg-card p-0.5">
          {(['ask', 'auto'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                'rounded px-2.5 py-0.5 text-xs font-medium capitalize transition-colors duration-fast',
                mode === m ? 'bg-primary text-primary-fg' : 'text-fg-2 hover:text-fg',
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-4 border-b border-border-light px-3">
        <TabButton active={tab === 'chat'} onClick={() => setTab('chat')}>
          Chat
        </TabButton>
        <TabButton active={tab === 'activity'} onClick={() => setTab('activity')}>
          Activity
          {threadState.toolStepCount > 0 ? (
            <span className="ml-1.5 rounded-pill bg-card px-1.5 text-[10px] font-medium text-fg-2">
              {threadState.toolStepCount}
            </span>
          ) : null}
        </TabButton>
        <TabButton active={tab === 'history'} onClick={() => setTab('history')}>
          History
        </TabButton>
      </div>

      {/* Body. CockpitChat owns the conversation; it stays MOUNTED across tab
          switches (hidden, not unmounted) so the SSE live-tail and optimistic
          state survive a hop to Activity/History and back. */}
      {loaded ? (
        <>
          <div className={cn('flex min-h-0 flex-1 flex-col', tab !== 'chat' && 'hidden')}>
            <CockpitChat
              key={recentId ?? 'new'}
              conversationId={recentId ?? undefined}
              modelLabel={MODEL_LABEL}
              modeLabel={modeLabel}
              onThreadState={setThreadState}
            />
          </div>
          {tab === 'activity' ? <ActivityPlaceholder count={threadState.toolStepCount} /> : null}
          {tab === 'history' ? <HistoryPlaceholder /> : null}
        </>
      ) : (
        <div className="min-h-0 flex-1" aria-hidden="true" />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        '-mb-px flex items-center border-b-2 py-2 text-sm font-medium transition-colors duration-fast',
        active ? 'border-primary text-fg' : 'border-transparent text-fg-2 hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}

function ActivityPlaceholder({ count }: { count: number }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <Icon icon={MessagesSquare} size={20} className="text-fg-3" />
      <p className="text-sm text-fg-2">
        {count > 0
          ? `${count} tool ${count === 1 ? 'step' : 'steps'} this conversation.`
          : 'No operator activity yet.'}
      </p>
      <p className="text-xs text-fg-3">A dedicated activity feed is coming.</p>
    </div>
  );
}

function HistoryPlaceholder() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <Icon icon={History} size={20} className="text-fg-3" />
      <p className="text-sm text-fg-2">Past conversations will appear here.</p>
      <p className="flex items-center gap-1 text-xs text-fg-3">
        <Icon icon={Clock} size={14} />
        Coming soon.
      </p>
    </div>
  );
}
