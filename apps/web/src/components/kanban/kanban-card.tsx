import { useDraggable } from '@dnd-kit/core';
import { Flag, Calendar } from 'lucide-react';
import { cn } from '../ui/cn.ts';
import { Icon } from '../ui/icon.tsx';
import { Avatar } from '../ui/avatar.tsx';
import type { DocumentSummary } from '../../lib/api/documents.ts';

interface Props {
  doc: DocumentSummary;
  onOpen: (slug: string) => void;
  isPending?: boolean;
}

const LABEL_HUES = [
  'bg-info',
  'bg-warning',
  'bg-success',
  'bg-danger',
  'bg-primary',
] as const;

function labelHue(label: string): string {
  let h = 0;
  for (let i = 0; i < label.length; i++) h = ((h << 5) - h + label.charCodeAt(i)) | 0;
  return LABEL_HUES[Math.abs(h) % LABEL_HUES.length] ?? LABEL_HUES[0];
}

export function KanbanCard({ doc, onOpen, isPending }: Props) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: doc.id,
    data: { slug: doc.slug, currentStatus: doc.status },
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: isDragging ? 50 : undefined }
    : undefined;

  const priority = typeof doc.frontmatter?.priority === 'string' ? doc.frontmatter.priority : null;
  const due = typeof doc.frontmatter?.due_date === 'string' ? doc.frontmatter.due_date : null;
  const assignee = typeof doc.frontmatter?.assignee === 'string' ? doc.frontmatter.assignee : null;
  const rawLabels = doc.frontmatter?.labels;
  const labels = Array.isArray(rawLabels)
    ? rawLabels.filter((l): l is string => typeof l === 'string')
    : [];
  const labelsShown = labels.slice(0, 2);
  const labelsOverflow = labels.length - labelsShown.length;
  const hasMeta = priority || due || assignee || labels.length > 0;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      role="button"
      tabIndex={0}
      onClick={() => {
        // Only open if this wasn't part of a drag (dnd-kit handles 5px activation).
        if (!isDragging) onOpen(doc.slug);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen(doc.slug);
      }}
      className={cn(
        'cursor-grab rounded-md border border-border-light bg-shell px-3 py-2 text-sm text-fg shadow-sm transition-shadow',
        isDragging && 'cursor-grabbing shadow-popover',
        isPending && 'opacity-60',
        'hover:bg-card focus:outline-none focus-visible:[box-shadow:var(--ring)]',
      )}
    >
      <div className="font-medium">{doc.title}</div>
      {labels.length > 0 ? (
        <div className="mt-1.5 flex items-center gap-1">
          {labelsShown.map((l) => (
            <span
              key={l}
              className="inline-flex items-center gap-1 rounded-sm bg-card px-1.5 py-0.5 text-[10px] text-fg-2"
              title={l}
            >
              <span className={cn('h-[6px] w-[6px] rounded-full', labelHue(l))} />
              {l}
            </span>
          ))}
          {labelsOverflow > 0 ? (
            <span className="text-[10px] text-fg-3" title={labels.slice(2).join(', ')}>
              +{labelsOverflow}
            </span>
          ) : null}
        </div>
      ) : null}
      {hasMeta ? (
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-fg-3">
          {priority ? (
            <span className="inline-flex items-center gap-1 rounded-sm bg-card px-1 py-0.5">
              <Icon icon={Flag} size={14} />
              {priority}
            </span>
          ) : null}
          {due ? (
            <span className="inline-flex items-center gap-1 font-mono">
              <Icon icon={Calendar} size={14} />
              {due}
            </span>
          ) : null}
          {assignee ? <Avatar name={assignee} size="xs" className="ml-auto" /> : null}
        </div>
      ) : null}
    </div>
  );
}
