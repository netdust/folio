import { useNavigate } from '@tanstack/react-router';
import { Bot, FileText, FolderKanban, ListChecks, MessageSquare, Play, Table2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ConversationMessage } from '../../lib/api/conversations.ts';
import { entityRoute, type EntityTarget, type EntityType } from './entity-route.ts';
import { parseMessagePayload } from './payload.ts';

interface LinkPanelPayload {
  type?: string;
  target?: EntityTarget;
  title?: string;
  subtitle?: string;
}

const ENTITY_ICON: Record<EntityType, LucideIcon> = {
  document: FileText,
  project: FolderKanban,
  view: Table2,
  work_item: ListChecks,
  agent: Bot,
  run: Play,
  conversation: MessageSquare,
};

/**
 * A `link_panel` component: a clickable card referencing an entity. Clicking
 * NAVIGATES the main area (TanStack Router) via the single `entityRoute` resolver
 * — the cockpit, a layout-level panel (not a modal), STAYS OPEN through the
 * navigation. The card shows the entity-type icon, title, and optional subtitle.
 */
export function MessageLinkPanel({ message }: { message: ConversationMessage }) {
  const navigate = useNavigate();
  const p = parseMessagePayload<LinkPanelPayload>(message.payload);
  const target = p.target;
  // Cluster-5 /code-review fix: guard the COMPLETENESS of target, not just its
  // presence. A truthy-but-incomplete target (missing entityType/entityId/wslug —
  // a malformed/corrupt row) would otherwise navigate to `/w/undefined`. The
  // tolerant-render contract is "one bad row never breaks the thread", so a
  // malformed link_panel degrades to no card rather than a broken navigation.
  if (!target || !target.entityType || !target.entityId || !target.wslug) return null;

  const Icon = ENTITY_ICON[target.entityType] ?? FileText;

  return (
    <button
      type="button"
      onClick={() => {
        void navigate(entityRoute(target));
      }}
      className="flex w-full items-start gap-3 rounded-lg border border-border-light bg-card px-3 py-2.5 text-left transition-colors duration-fast hover:border-border hover:bg-bg-2"
    >
      <Icon className="size-4 shrink-0 mt-0.5 text-fg-3" aria-hidden="true" />
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-fg">{p.title ?? target.entityId}</span>
        {p.subtitle ? (
          <span className="block truncate text-xs text-fg-3">{p.subtitle}</span>
        ) : null}
      </span>
    </button>
  );
}
