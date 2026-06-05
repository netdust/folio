import { useNavigate } from '@tanstack/react-router';
import { Bot, FileText, ListChecks, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ENTITY_TYPES, type EntityType } from '@folio/shared';
import type { ConversationMessage } from '../../lib/api/conversations.ts';
import { entityRoute, type EntityTarget } from './entity-route.ts';
import { parseMessagePayload } from './payload.ts';

interface LinkPanelPayload {
  type?: string;
  target?: EntityTarget;
  title?: string;
  subtitle?: string;
}

const ENTITY_ICON: Record<EntityType, LucideIcon> = {
  document: FileText,
  work_item: ListChecks,
  agent: Bot,
  trigger: Zap,
};

// The shared closed enum as a runtime Set — the renderer rejects a target whose
// entityType is not a KNOWN type (a corrupt/forward-compat row), not just an
// absent one (finding #10: presence ≠ validity).
const KNOWN_ENTITY_TYPES = new Set<string>(ENTITY_TYPES);

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
  // Cluster-5 /code-review fix: guard the VALIDITY of target, not just its
  // presence. (1) all three fields must be present (an incomplete target would
  // navigate to `/w/undefined`); (2) entityType must be a KNOWN type — a corrupt
  // or forward-compat entityType ('milestone') would otherwise render a
  // FileText card that navigates somewhere wrong via entityRoute's default
  // branch. The tolerant-render contract is "one bad/unknown row never breaks
  // the thread": a malformed link_panel degrades to no card.
  if (
    !target ||
    !target.entityType ||
    !target.entityId ||
    !target.wslug ||
    !KNOWN_ENTITY_TYPES.has(target.entityType) ||
    // document/work_item need pslug to resolve (they open at the project route);
    // a pslug-less such row would navigate to the workspace root — degrade to no
    // card instead (review #5; mirrors the server schema's pslug requirement).
    ((target.entityType === 'document' || target.entityType === 'work_item') && !target.pslug)
  ) {
    return null;
  }

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
