import { Skeleton } from '../ui/skeleton.tsx';

/**
 * Loading placeholder for the calendar view: a static 6×7 grid of pulsing
 * cells. Purely presentational — no date math, no data.
 */
export function CalendarSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col" aria-busy>
      <div className="mb-3 flex items-center gap-2">
        <Skeleton width={120} height={20} />
        <Skeleton width={28} height={28} rounded="md" />
        <Skeleton width={28} height={28} rounded="md" />
      </div>
      <div className="grid flex-1 grid-cols-7 gap-px overflow-hidden rounded-md bg-border-light">
        {Array.from({ length: 42 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static non-reordering skeleton cell, index key is stable
          <div key={i} className="min-h-[72px] bg-shell p-1">
            <Skeleton width={18} height={12} />
          </div>
        ))}
      </div>
    </div>
  );
}
