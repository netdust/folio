import { DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ReactNode } from 'react';
import { InlineEdit } from '../inline/inline-edit.tsx';
import { type Column, gridTemplate } from './columns.ts';

// SortKey is `string` because saved views can persist a sort by any column
// key (built-in or custom field). Every column header is clickable to sort;
// custom field sorts are validated server-side.
export type SortKey = string;
export type SortDir = 'asc' | 'desc';
export interface SortState {
  key: SortKey;
  dir: SortDir;
}

interface Props {
  columns: Column[]; // visible columns, already ordered
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
          {/* No `gap` — flush columns so each header cell's `border-l` aligns
              with the body's column separators. */}
          <div className="grid flex-1" style={{ gridTemplateColumns: gridTemplate(columns) }}>
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
  // Non-sticky header cells get a `border-l` + `px-3` so the header column
  // separators align with the body cells (TableCell) on flush (gap-less) grids.
  // The sticky first column does NOT paint `border-r` — col 1's `border-l` owns
  // the boundary line; a sticky `border-r` would double it (~2px) at that one
  // boundary (matches TableCell; ultrareview bug_007).
  const wrapperClass = `group/header relative flex items-center gap-1${
    isSticky
      ? ' sticky left-0 z-[1] bg-content pl-[22px] pr-3'
      : ' border-l border-border-light px-3'
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
          title={
            sortable
              ? `Sort by ${column.label} (drag to reorder)`
              : `Drag to reorder ${column.label}`
          }
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
