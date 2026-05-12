import { useDroppable } from '@dnd-kit/core';
import type { ReactNode } from 'react';
import { cn } from '../ui/cn.ts';
import type { Status } from '../../lib/api/statuses.ts';

interface Props {
  status: Status;
  count: number;
  children: ReactNode;
}

export function KanbanColumn({ status, count, children }: Props) {
  const { setNodeRef, isOver } = useDroppable({ id: `col-${status.key}`, data: { statusKey: status.key } });
  return (
    <div className="flex w-[280px] shrink-0 flex-col">
      <div className="mb-2 flex items-center gap-2 px-1">
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: status.color }} />
        <span className="text-sm font-medium text-fg">{status.name}</span>
        <span className="text-xs text-fg-3">{count}</span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          'flex min-h-[200px] flex-col gap-2 rounded-md p-1 transition-colors',
          isOver ? 'bg-card' : 'bg-transparent',
        )}
      >
        {children}
      </div>
    </div>
  );
}
