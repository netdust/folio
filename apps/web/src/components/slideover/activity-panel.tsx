import { useState } from 'react';
import { ChevronRight, History } from 'lucide-react';
import { useDocumentEvents, type DocumentEvent } from '../../lib/api/events.ts';
import { Icon } from '../ui/icon.tsx';
import { cn } from '../ui/cn.ts';
import { relativeTime } from '../../lib/relative-time.ts';

interface Props {
  wslug: string;
  pslug: string;
  slug: string;
}

export function ActivityPanel({ wslug, pslug, slug }: Props) {
  const [expanded, setExpanded] = useState(true);
  const { data: events, isLoading } = useDocumentEvents(wslug, pslug, slug);
  const rows = Array.isArray(events) ? events : [];

  return (
    <section className="pt-4">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="group/activity flex items-center gap-1.5 text-xs font-medium text-fg-2 hover:text-fg"
      >
        {/* Single-slot icon → chevron swap on hover, same pattern as the
            rail tree. History shows at rest; on hover it's replaced by a
            chevron that rotates 90° when the panel is expanded. */}
        <span className="relative inline-grid h-3.5 w-3.5 place-items-center">
          <Icon icon={History} size={14} className="group-hover/activity:hidden" />
          <Icon
            icon={ChevronRight}
            size={14}
            className={cn(
              'hidden transition-transform duration-fast group-hover/activity:inline-block',
              expanded ? 'rotate-90' : '',
            )}
          />
        </span>
        <span>Activity</span>
        {rows.length > 0 ? <span className="text-fg-3">({rows.length})</span> : null}
      </button>

      {expanded ? (
        <div className="mt-3 flex flex-col gap-1">
          {isLoading ? (
            <div className="text-xs text-fg-3">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="text-xs text-fg-3">No activity yet.</div>
          ) : (
            rows.map((e) => <ActivityRow key={e.id} event={e} />)
          )}
        </div>
      ) : null}
    </section>
  );
}

function ActivityRow({ event }: { event: DocumentEvent }) {
  const [open, setOpen] = useState(false);
  const isManual = event.kind === 'activity.logged';
  const note = isManual ? (event.payload as { note?: string } | null)?.note : null;

  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-card"
      >
        <span className={cn('font-medium', isManual ? 'text-fg' : 'text-fg-3')}>
          {labelForKind(event.kind)}
        </span>
        {note ? <span className="flex-1 truncate text-fg-2">{note}</span> : <span className="flex-1" />}
        <time className="text-fg-3 shrink-0">{relativeTime(event.createdAt)}</time>
      </button>
      {open ? (
        <pre className="mt-1 ml-3 max-h-[180px] overflow-auto rounded bg-card px-2 py-1.5 text-[10px] text-fg-3 whitespace-pre-wrap break-all">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

function labelForKind(kind: string): string {
  switch (kind) {
    case 'activity.logged': return 'Logged';
    case 'document.created': return 'Created';
    case 'document.updated': return 'Updated';
    case 'document.deleted': return 'Deleted';
    case 'status.updated': return 'Status changed';
    default: return kind;
  }
}

