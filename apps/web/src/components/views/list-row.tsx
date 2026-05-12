import { toast } from 'sonner';
import { InlineEdit } from '../inline/inline-edit.tsx';
import { InlineSelect } from '../inline/inline-select.tsx';
import type { DocumentSummary } from '../../lib/api/documents.ts';
import type { Status } from '../../lib/api/statuses.ts';
import { formatApiError } from '../../lib/api/index.ts';

interface Props {
  doc: DocumentSummary;
  statuses: Status[];
  onOpen: (slug: string) => void;
  onUpdate: (vars: { slug: string; patch: { title?: string; status?: string | null } }) => Promise<unknown>;
  pendingSlugs: Set<string>;
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

export function ListRow({ doc, statuses, onOpen, onUpdate, pendingSlugs }: Props) {
  const status = doc.status ? statuses.find((s) => s.key === doc.status) : null;
  const isPending = pendingSlugs.has(doc.slug);

  const onCommitTitle = async (next: string) => {
    try {
      await onUpdate({ slug: doc.slug, patch: { title: next } });
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };
  const onCommitStatus = async (next: string) => {
    try {
      await onUpdate({ slug: doc.slug, patch: { status: next } });
    } catch (err) {
      toast.error(formatApiError(err));
    }
  };

  return (
    <div
      role="listitem"
      className="grid w-full grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-border-light px-4 py-2 hover:bg-card"
    >
      <div className="min-w-0 flex items-center gap-2">
        <button
          type="button"
          aria-label="Open document"
          onClick={() => onOpen(doc.slug)}
          className="text-fg-3 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <span className="font-mono text-[11px]">↗</span>
        </button>
        <div className="min-w-0 flex-1">
          <InlineEdit
            value={doc.title}
            onCommit={onCommitTitle}
            isPending={isPending}
            ariaLabel="Document title"
          />
        </div>
      </div>

      <InlineSelect
        value={doc.status}
        options={statuses.map((s) => ({ value: s.key, label: s.name, color: s.color }))}
        onCommit={onCommitStatus}
        isPending={isPending}
        placeholder="no status"
        renderDisplay={(opt) =>
          opt ? (
            <span
              className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5"
              style={{ backgroundColor: `${opt.color}22`, color: opt.color }}
            >
              <span>{opt.label}</span>
            </span>
          ) : (
            <span className="text-xs text-fg-3">no status</span>
          )
        }
      />

      <span className="font-mono text-[11px] text-fg-3">{relativeTime(doc.updatedAt)}</span>
    </div>
  );
}
