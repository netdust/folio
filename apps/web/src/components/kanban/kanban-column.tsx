import { useDroppable } from '@dnd-kit/core';
import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../ui/cn.ts';
import { Icon } from '../ui/icon.tsx';
import type { Status } from '../../lib/api/statuses.ts';

interface Props {
  status: Status;
  count: number;
  onAdd?: () => void;
  isAddPending?: boolean;
  children: ReactNode;
}

export function KanbanColumn({ status, count, onAdd, isAddPending, children }: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: `col-${status.key}`, data: { statusKey: status.key } });
  return (
    <div className="flex w-[280px] shrink-0 flex-col">
      <div className="mb-1 flex items-center gap-2 px-2 py-1">
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: status.color }} />
        <span className="text-sm font-medium text-fg">{status.name}</span>
        <span className="font-mono text-[11px] text-fg-3">{count}</span>
        {onAdd ? (
          <button
            type="button"
            onClick={onAdd}
            disabled={isAddPending}
            aria-label={`New work item in ${status.name}`}
            className="ml-auto grid h-[22px] w-[22px] place-items-center rounded-sm text-fg-3 hover:bg-card hover:text-fg-2 focus:outline-none focus-visible:[box-shadow:var(--ring)] disabled:opacity-50"
          >
            <Icon icon={Plus} size={14} />
          </button>
        ) : null}
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          'flex min-h-[200px] flex-1 flex-col gap-1.5 rounded-lg p-1 transition-colors',
          isOver ? 'bg-card' : 'bg-board-col',
        )}
      >
        {children}
      </div>
    </div>
  );
}
