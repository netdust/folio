import { ArrowUpRight } from 'lucide-react';
import type { DocumentSummary } from '../../lib/api/documents.ts';
import type { Status } from '../../lib/api/statuses.ts';
import { dueUrgency, urgencyClasses } from '../../lib/due-urgency.ts';
import { relativeTime } from '../../lib/relative-time.ts';
import { AssigneePicker } from '../assignee/assignee-picker.tsx';
import { InlineEdit } from '../inline/inline-edit.tsx';
import { InlineSelect } from '../inline/inline-select.tsx';
import { FieldRenderer } from '../slideover/field-renderer.tsx';
import { cn } from '../ui/cn.ts';
import { Icon } from '../ui/icon.tsx';
import { Pill } from '../ui/pill.tsx';
import type { Column } from './columns.ts';

interface Props {
  column: Column;
  doc: DocumentSummary;
  statuses: Status[];
  // Workspace/project context — required because the assignee cell mounts the
  // AssigneePicker, which needs them to load members + project-allowed agents.
  // TableRow always has them, so they are required (a missed call site is a
  // compile error).
  wslug: string;
  pslug: string;
  isPending: boolean;
  isSticky?: boolean;
  onOpen: (slug: string) => void;
  onTitleCommit: (slug: string, next: string) => void;
  onStatusCommit: (slug: string, next: string) => void;
  onFieldCommit: (slug: string, key: string, next: unknown) => void;
  // Project-wide slug→title resolver for relation columns. Threading this
  // (WITHOUT relationCandidates) keeps the table relation cell read-only but
  // lets valid links render as titled chips instead of struck-through
  // "broken-link" tokens. Finding 9.
  resolveRelation?: (slug: string) => { slug: string; title: string } | null;
}

export function TableCell({
  column,
  doc,
  statuses,
  wslug,
  pslug,
  isPending,
  isSticky = false,
  onOpen,
  onTitleCommit,
  onStatusCommit,
  onFieldCommit,
  resolveRelation,
}: Props) {
  const content = renderContent();
  // Every cell vertically centers its content with `flex items-center` so all
  // field types align on the same midline regardless of their intrinsic box
  // height (the native date input is taller than a text span, which otherwise
  // made the date sit higher than its row siblings). `min-w-0` lets truncating
  // children shrink. `border-l` draws the inter-column separator on EVERY
  // non-sticky cell — including col 1, whose border-l owns the sticky↔col-1
  // boundary line. The sticky cell therefore does NOT paint `border-r` (it would
  // double up against col 1's border-l → a ~2px line at that one boundary while
  // every other is 1px — ultrareview bug_007).
  if (!isSticky)
    return (
      <div className="flex min-w-0 items-center border-l border-border-light px-3">{content}</div>
    );
  return (
    <div className="sticky left-0 z-[1] flex items-center bg-content pl-[22px] pr-3 group-hover/row:bg-card">
      {content}
    </div>
  );

  function renderContent() {
    if (column.source === 'builtin') {
      if (column.key === 'title') {
        return (
          <div className="flex min-w-0 items-center gap-2" title={doc.title}>
            <button
              type="button"
              aria-label={`Open ${doc.title}`}
              onClick={() => onOpen(doc.slug)}
              className="shrink-0 text-fg-3 hover:text-fg"
            >
              <Icon icon={ArrowUpRight} size={14} />
            </button>
            <div className="min-w-0 flex-1">
              <InlineEdit
                value={doc.title}
                onCommit={(v) => onTitleCommit(doc.slug, v)}
                isPending={isPending}
                ariaLabel={`Edit title: ${doc.title}`}
                className="block w-full truncate"
              />
            </div>
          </div>
        );
      }
      if (column.key === 'status') {
        const current = doc.status ? (statuses.find((s) => s.key === doc.status) ?? null) : null;
        return (
          <InlineSelect
            value={doc.status}
            options={statuses.map((s) => ({ value: s.key, label: s.name, color: s.color }))}
            onCommit={(v) => onStatusCommit(doc.slug, v)}
            isPending={isPending}
            placeholder="no status"
            renderDisplay={(opt) =>
              opt && current ? (
                <Pill category={current.category} label={opt.label} />
              ) : (
                <span className="text-xs text-fg-3">no status</span>
              )
            }
          />
        );
      }
      if (column.key === 'updated_at') {
        return (
          <span className="font-mono text-[11px] text-fg-3">{relativeTime(doc.updatedAt)}</span>
        );
      }
      return null;
    }
    if (!column.fieldType) return null;
    const value = doc.frontmatter?.[column.key];
    // The `assignee` field renders the AssigneePicker (member/agent select +
    // search), mirroring the slideover's `key === 'assignee'` branch — instead
    // of the plain-text InlineEdit FieldRenderer gives `user_ref`. Same
    // onFieldCommit path as every other field, so the optimistic write + event
    // emission are identical.
    if (column.key === 'assignee') {
      return (
        <AssigneePicker
          wslug={wslug}
          pslug={pslug}
          value={typeof value === 'string' ? value : ''}
          onChange={(next) => onFieldCommit(doc.slug, column.key, next)}
        />
      );
    }
    // Generic across any date column — the "frontmatter is the schema" rule
    // means urgency must follow the type, not a hardcoded key like
    // `next_action_due`.
    const urgencyClass = column.fieldType === 'date' ? urgencyClasses(dueUrgency(value)) : '';
    const rendered = (
      <FieldRenderer
        fieldKey={column.key}
        type={column.fieldType}
        value={value}
        options={column.fieldOptions ?? undefined}
        onCommit={(next) => onFieldCommit(doc.slug, column.key, next)}
        isPending={isPending}
        resolveSlug={resolveRelation}
      />
    );
    if (!urgencyClass) return rendered;
    // Urgency color wrapper (date cells only). Must be `flex items-center` — a
    // plain `block` span collapsed to its content's baseline, so the date text
    // sat above the row midline once the cell gained `flex items-center` (every
    // other field returns `rendered` bare and centers directly). Centering this
    // wrapper too puts the date on the same midline as its siblings.
    // (`display: contents` is avoided — stripped from the a11y tree in Safari
    // <17 and breaks grid layout if FieldRenderer returns a fragment.)
    return <span className={cn('flex items-center', urgencyClass)}>{rendered}</span>;
  }
}
