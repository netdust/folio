import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { useSortable, SortableContext, horizontalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ReactNode } from 'react';
import { gridTemplate, type Column } from './columns.ts';
import { InlineEdit } from '../inline/inline-edit.tsx';

// SortKey is `string` because saved views can persist a sort by any column
// key (built-in or custom field). Every column header is clickable to sort;
// custom field sorts are validated server-side.
export type SortKey = string;
export type SortDir = 'asc' | 'desc';
export interface SortState { key: SortKey; dir: SortDir; }

interface Props {
  columns: Column[];         // visible columns, already ordered
  sort: SortState | null;
  onSort: (next: SortState | null) => void;
  onReorder: (nextOrder: string[]) => void;
  trailing?: ReactNode;
  settings?: ReactNode;
  renderColumnMenu?: (column: Column) => ReactNode;
  // When set, the matching column header swaps its label for an InlineEdit
  // input. Commit fires onRenameCommit(key, nextLabel); the parent clears
  // renamingKey on commit or Escape.
  renamingKey?: string | null;
  onRenameCommit?: (key: string, nextLabel: string) => void;
}

export function TableHeader({
  columns,
  sort,
  onSort,
  onReorder,
  trailing,
  settings,
  renderColumnMenu,
  renamingKey,
  onRenameCommit,
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
            {columns.map((c, i) => (
              <SortableHeaderCell
                key={c.key}
                column={c}
                sort={sort}
                onSort={onSort}
                isSticky={i === 0}
                renderColumnMenu={renderColumnMenu}
                isRenaming={renamingKey === c.key}
                onRenameCommit={onRenameCommit}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {trailing ? <div className="flex-shrink-0">{trailing}</div> : null}
      {settings ? (
        <div
          data-testid="table-settings-col"
          className="sticky right-0 z-[1] flex h-full w-11 flex-shrink-0 items-center justify-center border-l border-border-light bg-content"
        >
          {settings}
        </div>
      ) : null}
    </div>
  );
}

function SortableHeaderCell({
  column,
  sort,
  onSort,
  isSticky = false,
  renderColumnMenu,
  isRenaming = false,
  onRenameCommit,
}: {
  column: Column;
  sort: SortState | null;
  onSort: (next: SortState | null) => void;
  isSticky?: boolean;
  renderColumnMenu?: (column: Column) => ReactNode;
  isRenaming?: boolean;
  onRenameCommit?: (key: string, nextLabel: string) => void;
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: column.key,
  });
  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  const sortable = true; // every column is sortable; field sort is validated server-side
  const onClick = sortable
    ? () => {
        const isActive = sort?.key === column.key;
        if (!isActive) onSort({ key: column.key as SortKey, dir: 'asc' });
        else if (sort.dir === 'asc') onSort({ key: column.key as SortKey, dir: 'desc' });
        else onSort(null);
      }
    : undefined;

  // Sticky-first-column whitespace moves to the OUTER wrapper so the menu
  // button still sits inside the sticky cell on horizontal scroll. The
  // group/header named-group reveals the menu on header-cell hover, not row
  // hover.
  const wrapperClass = `group/header relative inline-flex items-center gap-1${
    isSticky ? ' sticky left-0 z-[1] border-r border-border-light bg-content pl-[22px] pr-3' : ''
  }`;

  return (
    <div ref={setNodeRef} style={style} className={wrapperClass}>
      {isRenaming && onRenameCommit ? (
        <InlineEdit
          value={column.label}
          onCommit={(next) => onRenameCommit(column.key, next)}
          defaultEditing
          ariaLabel={`Rename column ${column.label}`}
          inputClassName="text-[11px] uppercase tracking-wide"
        />
      ) : (
        <button
          type="button"
          {...attributes}
          {...listeners}
          onClick={onClick}
          title={sortable ? `Sort by ${column.label} (drag to reorder)` : `Drag to reorder ${column.label}`}
          className="flex flex-1 cursor-grab items-center gap-1 text-left text-[11px] uppercase tracking-wide text-fg-3 hover:text-fg-2 active:cursor-grabbing"
        >
          {column.label}
          {sort?.key === column.key ? (
            <span className="font-mono text-[10px]">{sort.dir === 'asc' ? '↑' : '↓'}</span>
          ) : null}
        </button>
      )}
      {column.source === 'field' && renderColumnMenu ? (
        <span className="opacity-0 transition-opacity group-hover/header:opacity-100">
          {renderColumnMenu(column)}
        </span>
      ) : null}
    </div>
  );
}
