import { Pill } from '../ui/pill.tsx';
import type { DocumentSummary } from '../../lib/api/documents.ts';
import type { Status } from '../../lib/api/statuses.ts';

interface Props {
  doc: DocumentSummary;
  statuses: Status[];
  onOpen: (slug: string) => void;
}

function relativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = Math.round((now - then) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function ListRow({ doc, statuses, onOpen }: Props) {
  const status = doc.status ? statuses.find((s) => s.key === doc.status) : null;
  return (
    <button
      type="button"
      onClick={() => onOpen(doc.slug)}
      className="grid w-full grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-border-light px-4 py-2 text-left transition-colors duration-fast hover:bg-card focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <span className="truncate text-sm text-fg">{doc.title}</span>
      {status ? (
        <Pill category={status.category} label={status.name} />
      ) : (
        <span className="text-xs text-fg-3">no status</span>
      )}
      <span className="font-mono text-[11px] text-fg-3">{relativeTime(doc.updatedAt)}</span>
    </button>
  );
}
