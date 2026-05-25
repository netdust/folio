import { ArrowUpRight } from 'lucide-react';
import { InlineEdit } from '../inline/inline-edit.tsx';
import { InlineSelect } from '../inline/inline-select.tsx';
import { Icon } from '../ui/icon.tsx';
import { Pill } from '../ui/pill.tsx';
import { cn } from '../ui/cn.ts';
import { FieldRenderer } from '../slideover/field-renderer.tsx';
import type { Column } from './columns.ts';
import type { DocumentSummary } from '../../lib/api/documents.ts';
import type { Status } from '../../lib/api/statuses.ts';
import { relativeTime } from '../../lib/relative-time.ts';
import { dueUrgency, urgencyClasses } from '../../lib/due-urgency.ts';

interface Props {
  column: Column;
  doc: DocumentSummary;
  statuses: Status[];
  isPending: boolean;
  isSticky?: boolean;
  onOpen: (slug: string) => void;
  onTitleCommit: (slug: string, next: string) => void;
  onStatusCommit: (slug: string, next: string) => void;
  onFieldCommit: (slug: string, key: string, next: unknown) => void;
}

export function TableCell({
  column,
  doc,
  statuses,
  isPending,
  isSticky = false,
  onOpen,
  onTitleCommit,
  onStatusCommit,
  onFieldCommit,
}: Props) {
  const content = renderContent();
  if (!isSticky) return content;
  return (
    <div className="sticky left-0 z-[1] flex items-center border-r border-border-light bg-content pl-[22px] pr-3 group-hover/row:bg-card">{content}</div>
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
        const current = doc.status ? statuses.find((s) => s.key === doc.status) ?? null : null;
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
        return <span className="font-mono text-[11px] text-fg-3">{relativeTime(doc.updatedAt)}</span>;
      }
      return null;
    }
    if (!column.fieldType) return null;
    const value = doc.frontmatter?.[column.key];
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
      />
    );
    if (!urgencyClass) return rendered;
    // A normal block wrapper — color cascades into the date pill below it.
    // Previously this was `display: contents` to avoid an extra box, but
    // that element is stripped from the accessibility tree in Safari <17
    // and breaks grid layout if FieldRenderer ever returns a fragment.
    return <span className={cn('block', urgencyClass)}>{rendered}</span>;
  }
}
