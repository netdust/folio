import { useDraggable, type DraggableAttributes } from '@dnd-kit/core';
import type { SyntheticListenerMap } from '@dnd-kit/core/dist/hooks/utilities';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Flag, Calendar } from 'lucide-react';
import type { CSSProperties } from 'react';
import { cn } from '../ui/cn.ts';
import { Icon } from '../ui/icon.tsx';
import { Avatar } from '../ui/avatar.tsx';
import type { DocumentSummary } from '../../lib/api/documents.ts';

interface Props {
  doc: DocumentSummary;
  onOpen: (slug: string) => void;
  isPending?: boolean;
  // When the board is in manual mode, cards become sortable so they can be
  // reordered within a column. Otherwise they are plain draggables (cross-
  // column regroup only).
  sortable?: boolean;
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

// dnd bindings shared between the sortable and draggable wrappers. Both dnd-kit
// hooks expose the same shape we consume here; `transition` is sortable-only.
interface DndBindings {
  setNodeRef: (node: HTMLElement | null) => void;
  attributes: DraggableAttributes;
  listeners: SyntheticListenerMap | undefined;
  style: CSSProperties | undefined;
  isDragging: boolean;
}

function CardBody({ doc, onOpen, isPending, dnd }: { doc: DocumentSummary; onOpen: (slug: string) => void; isPending?: boolean; dnd: DndBindings }) {
  const { setNodeRef, attributes, listeners, style, isDragging } = dnd;

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
        // Base bg lifted from `bg-shell` to `bg-content` so the card stands
        // out from the kanban column's tinted body. Hover adds a clear bg +
        // border step so the hover state is visible against the elevated
        // base. Bug G (2026-05-26).
        'cursor-grab rounded-md border border-border-light bg-content px-3 py-2 text-sm text-fg shadow-sm transition-colors',
        isDragging && 'cursor-grabbing shadow-popover',
        isPending && 'opacity-60',
        'hover:border-fg-3 hover:bg-card',
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

function DraggableCard({ doc, onOpen, isPending }: Omit<Props, 'sortable'>) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: doc.id,
    data: { slug: doc.slug, currentStatus: doc.status },
  });
  const style: CSSProperties | undefined = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: isDragging ? 50 : undefined }
    : undefined;
  return <CardBody doc={doc} onOpen={onOpen} isPending={isPending} dnd={{ setNodeRef, attributes, listeners, style, isDragging }} />;
}

function SortableCard({ doc, onOpen, isPending }: Omit<Props, 'sortable'>) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: doc.id,
    data: { slug: doc.slug, currentStatus: doc.status },
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
  };
  return <CardBody doc={doc} onOpen={onOpen} isPending={isPending} dnd={{ setNodeRef, attributes, listeners, style, isDragging }} />;
}

export function KanbanCard({ doc, onOpen, isPending, sortable }: Props) {
  return sortable ? (
    <SortableCard doc={doc} onOpen={onOpen} isPending={isPending} />
  ) : (
    <DraggableCard doc={doc} onOpen={onOpen} isPending={isPending} />
  );
}
