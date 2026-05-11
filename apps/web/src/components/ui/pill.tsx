import { cn } from './cn.ts';

type Category = 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled';

interface PillProps {
  category: Category;
  label: string;
  className?: string;
}

const dotColor: Record<Category, string> = {
  backlog:   'bg-fg-3',
  unstarted: 'bg-info',
  started:   'bg-warning',
  completed: 'bg-success',
  cancelled: 'bg-fg-3',
};

const textColor: Record<Category, string> = {
  backlog:   'text-fg-3',
  unstarted: 'text-info',
  started:   'text-warning',
  completed: 'text-success',
  cancelled: 'text-fg-3 line-through',
};

export function Pill({ category, label, className }: PillProps) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs', textColor[category], className)}>
      <span className={cn('h-[7px] w-[7px] rounded-full', dotColor[category])} />
      {label}
    </span>
  );
}
