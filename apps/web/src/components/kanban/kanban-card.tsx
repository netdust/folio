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
  // When true, render a non-interactive presentational clone with NO dnd hook
  // (used inside <DragOverlay>). The overlay portals to the body so it escapes
  // the column's `overflow-y-auto` clip and paints above the sibling columns.
  overlay?: boolean;
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

function DraggableCard({ doc, onOpen, isPending }: Omit<Props, 'sortable' | 'overlay'>) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: doc.id,
    data: { slug: doc.slug, currentStatus: doc.status },
  });
  // The dragged card is rendered by <DragOverlay> (portaled above everything so
  // it escapes the column's overflow clip), so the in-place node hides while
  // dragging — otherwise two cards would show. No transform/zIndex needed here.
  const style: CSSProperties | undefined = isDragging ? { opacity: 0 } : undefined;
  return <CardBody doc={doc} onOpen={onOpen} isPending={isPending} dnd={{ setNodeRef, attributes, listeners, style, isDragging }} />;
}

function SortableCard({ doc, onOpen, isPending }: Omit<Props, 'sortable' | 'overlay'>) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: doc.id,
    data: { slug: doc.slug, currentStatus: doc.status },
    // Bug 1 (2026-06-07): the dropped card visibly slid BACK toward its origin
    // slot. After release dnd-kit briefly keeps a transform on the just-dropped
    // item and its `transition` animates it home (matrix(…,-68px) → 0 over
    // ~200ms). The DragOverlay clone is the visible drag element, so the
    // underlying node must NOT also animate. Disable layout-change animation for
    // THIS item — other cards still animate their shift-to-make-room (they call
    // useSortable independently with the default animateLayoutChanges).
    animateLayoutChanges: () => false,
  });
  // Keep the sortable transform so the OTHER cards shift to make room. The
  // dragged card itself is hidden (the DragOverlay clone is the visible one) AND
  // kept inert: while dragging, drop the leftover transform + transition so the
  // in-place node never animates back to origin on drop.
  const style: CSSProperties = isDragging
    ? { opacity: 0, transition: 'none', transform: undefined }
    : { transform: CSS.Transform.toString(transform), transition };
  return <CardBody doc={doc} onOpen={onOpen} isPending={isPending} dnd={{ setNodeRef, attributes, listeners, style, isDragging }} />;
}

// Presentational clone for <DragOverlay> — no dnd hook, not interactive. It just
// needs to LOOK like the card; the overlay handles positioning + z-stacking.
function OverlayCard({ doc, isPending }: Pick<Props, 'doc' | 'isPending'>) {
  return (
    <CardBody
      doc={doc}
      onOpen={() => {}}
      isPending={isPending}
      dnd={{ setNodeRef: () => {}, attributes: {} as DraggableAttributes, listeners: undefined, style: undefined, isDragging: true }}
    />
  );
}

export function KanbanCard({ doc, onOpen, isPending, sortable, overlay }: Props) {
  if (overlay) return <OverlayCard doc={doc} isPending={isPending} />;
  return sortable ? (
    <SortableCard doc={doc} onOpen={onOpen} isPending={isPending} />
  ) : (
    <DraggableCard doc={doc} onOpen={onOpen} isPending={isPending} />
  );
}
