import { useDroppable } from '@dnd-kit/core';
import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../ui/cn.ts';
import { Icon } from '../ui/icon.tsx';

interface Props {
  value: string | null;
  label: string;
  color?: string;
  count: number;
  onAdd?: () => void;
  isAddPending?: boolean;
  children: ReactNode;
}

export function KanbanColumn({ value, label, color, count, onAdd, isAddPending, children }: Props) {
  const colId = `col-${value ?? '__unset__'}`;
  const { setNodeRef, isOver } = useDroppable({ id: colId, data: { columnValue: value } });
  return (
    <div className="flex w-[280px] shrink-0 flex-col">
      <div className="mb-1 flex items-center gap-2 px-2 py-1">
        {/* When a color is provided (status grouping) render the colored dot.
            Otherwise render a transparent placeholder of the same footprint so
            the text + count baseline aligns with colored-dot headers. */}
        {color ? (
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
        ) : (
          <span className="h-2 w-2 rounded-full" aria-hidden />
        )}
        <span className={cn('text-sm font-medium', value === null ? 'text-fg-3' : 'text-fg')}>{label}</span>
        <span className="font-mono text-[11px] text-fg-3">{count}</span>
        {onAdd ? (
          <button
            type="button"
            onClick={onAdd}
            disabled={isAddPending}
            aria-label={`New work item in ${label}`}
            className="ml-auto grid h-[22px] w-[22px] place-items-center rounded-sm text-fg-3 hover:bg-card hover:text-fg-2 disabled:opacity-50"
          >
            <Icon icon={Plus} size={14} />
          </button>
        ) : null}
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          'flex min-h-[200px] flex-1 flex-col gap-1.5 rounded-lg p-1 transition-colors',
          isOver ? 'bg-card' : 'bg-[rgb(0_0_0_/_0.025)] dark:bg-[rgb(255_255_255_/_0.03)]',
        )}
      >
        {children}
      </div>
    </div>
  );
}
