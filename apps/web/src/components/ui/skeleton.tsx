import { cn } from './cn.ts';

interface Props {
  className?: string;
  width?: number | string;
  height?: number | string;
  rounded?: 'sm' | 'md' | 'pill';
}

export function Skeleton({ width, height, rounded = 'sm', className }: Props) {
  return (
    <div
      style={{ width, height }}
      aria-hidden
      className={cn(
        'animate-pulse bg-card',
        rounded === 'sm' && 'rounded-sm',
        rounded === 'md' && 'rounded-md',
        rounded === 'pill' && 'rounded-pill',
        className,
      )}
    />
  );
}
