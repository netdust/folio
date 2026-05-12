import { useDraggable } from '@dnd-kit/core';
import { Flag, Calendar } from 'lucide-react';
import { cn } from '../ui/cn.ts';
import { Icon } from '../ui/icon.tsx';
import type { DocumentSummary } from '../../lib/api/documents.ts';

interface Props {
  doc: DocumentSummary;
  onOpen: (slug: string) => void;
  isPending?: boolean;
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
        'hover:bg-card focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
      )}
    >
      <div className="font-medium">{doc.title}</div>
      {(priority || due) ? (
        <div className="mt-1 flex items-center gap-2 text-[11px] text-fg-3">
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
        </div>
      ) : null}
    </div>
  );
}
