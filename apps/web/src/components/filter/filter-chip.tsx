import type { ReactNode } from 'react';
import { cn } from '../ui/cn.ts';

interface Props {
  filterKey: string;
  value: ReactNode;
  onRemove: () => void;
  onClick?: () => void;
}

export function FilterChip({ filterKey, value, onRemove, onClick }: Props) {
  return (
    <span className="inline-flex items-center gap-1 rounded-pill bg-card pl-2.5 pr-1 py-0.5 text-xs">
      <button
        type="button"
        onClick={onClick}
        className={cn(onClick ? 'cursor-pointer' : 'cursor-default')}
      >
        <span className="text-fg-3">{filterKey}</span>{' '}
        <span className="font-medium text-fg">{value}</span>
      </button>
      <button
        type="button"
        aria-label={`Remove ${filterKey} filter`}
        onClick={onRemove}
        className="ml-0.5 inline-grid h-4 w-4 place-items-center rounded-full text-fg-3 hover:bg-shell hover:text-fg"
      >
        ×
      </button>
    </span>
  );
}
