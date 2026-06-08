import { useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import { agentPanelBus, type AgentPanelState } from '../../lib/agent-panel-bus.ts';
import { useRecentConversation } from '../../lib/api/conversations.ts';
import { Icon } from '../ui/icon.tsx';
import { CockpitChat } from './cockpit-chat.tsx';

/**
 * The layout-level operator cockpit panel (T12). Renders the operator CHAT —
 * the Activity/Run tab surfaces are gone (deleted in T14). Open/closed is driven
 * by `agentPanelBus` (default-open, respect-last-closed). It is a panel, NOT a
 * modal: the main area stays interactive behind it and a link_panel click
 * navigates the main area without closing the cockpit.
 *
 * useSyncExternalStore subscribes synchronously and re-reads the snapshot, so an
 * emit that lands in the render→effect gap on first mount is never missed (no
 * external-store tearing); the bus replaces `state` per change so the snapshot
 * identity is stable between renders (no render loop).
 */
export function AgentCockpitPanel() {
  const state: AgentPanelState = useSyncExternalStore(agentPanelBus.subscribe, agentPanelBus.get);
  const { recentId, loaded } = useRecentConversation();
  if (!state.open) return null;
  return (
    <div className="flex w-[360px] shrink-0 flex-col rounded-md border border-border-light bg-content">
      <div className="flex items-center gap-2 border-b border-border-light px-3 py-2.5">
        <strong className="flex-1 truncate text-fg">Operator</strong>
        <button
          type="button"
          aria-label="Close"
          onClick={() => agentPanelBus.close()}
          className="grid h-6 w-6 place-items-center rounded text-fg-3 hover:bg-card hover:text-fg"
        >
          <Icon icon={X} size={16} />
        </button>
      </div>
      {/* Hold the chat body until the recent-id seed resolves so a user WITH a
          conversation never flashes the empty greeting first. `key` forces a
          fresh CockpitChat once the seed lands so its internal activeId useState
          picks up the resumed id. */}
      {loaded ? (
        <CockpitChat key={recentId ?? 'new'} conversationId={recentId ?? undefined} />
      ) : (
        <div className="min-h-0 flex-1" aria-hidden="true" />
      )}
    </div>
  );
}
