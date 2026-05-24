import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { useSortable, SortableContext, horizontalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ColumnPicker } from './column-picker.tsx';
import { gridTemplate, type Column } from './columns.ts';

export type SortKey = 'title' | 'status' | 'updated_at';
export type SortDir = 'asc' | 'desc';
export interface SortState { key: SortKey; dir: SortDir; }

const SORTABLE_BUILTIN_KEYS: SortKey[] = ['title', 'status', 'updated_at'];

interface Props {
  columns: Column[];         // visible columns, already ordered
  allColumns: Column[];      // every column (for the picker)
  visibleKeys: string[];
  sort: SortState | null;
  onSort: (next: SortState | null) => void;
  onVisibilityChange: (next: string[]) => void;
  onReorder: (nextOrder: string[]) => void;
}

export function TableHeader({
  columns,
  allColumns,
  visibleKeys,
  sort,
  onSort,
  onVisibilityChange,
  onReorder,
}: Props) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const ids = columns.map((c) => c.key);

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = ids.indexOf(String(e.active.id));
    const to = ids.indexOf(String(e.over.id));
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(ids, from, to));
  };

  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border-light bg-content py-1.5">
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
          <div
            className="grid flex-1 gap-3"
            style={{ gridTemplateColumns: gridTemplate(columns) }}
          >
            {(() => {
              const last = columns[columns.length - 1];
              return (
                <>
                  {columns.slice(0, -1).map((c, i) => (
                    <SortableHeaderCell key={c.key} column={c} sort={sort} onSort={onSort} isSticky={i === 0} />
                  ))}
                  {columns.length > 1 ? <span aria-hidden /> : null}
                  {last ? (
                    <SortableHeaderCell
                      key={last.key}
                      column={last}
                      sort={sort}
                      onSort={onSort}
                      isSticky={columns.length === 1}
                    />
                  ) : null}
                </>
              );
            })()}
          </div>
        </SortableContext>
      </DndContext>
      <ColumnPicker columns={allColumns} visibleKeys={visibleKeys} onChange={onVisibilityChange} />
    </div>
  );
}

function SortableHeaderCell({
  column,
  sort,
  onSort,
  isSticky = false,
}: {
  column: Column;
  sort: SortState | null;
  onSort: (next: SortState | null) => void;
  isSticky?: boolean;
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: column.key,
  });
  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  const sortable =
    column.source === 'builtin' && SORTABLE_BUILTIN_KEYS.includes(column.key as SortKey);
  const onClick = sortable
    ? () => {
        const isActive = sort?.key === column.key;
        if (!isActive) onSort({ key: column.key as SortKey, dir: 'asc' });
        else if (sort.dir === 'asc') onSort({ key: column.key as SortKey, dir: 'desc' });
        else onSort(null);
      }
    : undefined;

  return (
    <button
      ref={setNodeRef}
      style={style}
      type="button"
      {...attributes}
      {...listeners}
      onClick={onClick}
      title={sortable ? `Sort by ${column.label} (drag to reorder)` : `Drag to reorder ${column.label}`}
      className={`inline-flex cursor-grab items-center gap-1 text-left text-[11px] uppercase tracking-wide text-fg-3 hover:text-fg-2 active:cursor-grabbing${isSticky ? ' sticky left-0 z-[1] bg-content' : ''}`}
    >
      {column.label}
      {sort?.key === column.key ? (
        <span className="font-mono text-[10px]">{sort.dir === 'asc' ? '↑' : '↓'}</span>
      ) : null}
    </button>
  );
}
