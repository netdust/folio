import { Skeleton } from '../ui/skeleton.tsx';

/**
 * Loading placeholder for the timeline view: a static horizontal scale header +
 * a handful of pulsing bar rows. Purely presentational — no date math, no data.
 */
export function TimelineSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col" aria-busy>
      <div className="mb-3 flex items-center gap-2">
        <Skeleton width={120} height={20} />
        <div className="ml-auto flex items-center gap-1">
          <Skeleton width={44} height={28} rounded="md" />
          <Skeleton width={44} height={28} rounded="md" />
          <Skeleton width={44} height={28} rounded="md" />
        </div>
      </div>
      {/* Scale header row */}
      <div className="flex gap-px border-b border-border-light pb-1">
        {Array.from({ length: 8 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static non-reordering skeleton column
          <Skeleton key={i} width={64} height={14} />
        ))}
      </div>
      {/* A few placeholder bars at staggered offsets. */}
      <div className="mt-3 flex flex-col gap-2">
        {[120, 200, 90, 160].map((w, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static non-reordering skeleton bar
          <div key={i} style={{ marginLeft: i * 40 }}>
            <Skeleton width={w} height={20} rounded="md" />
          </div>
        ))}
      </div>
    </div>
  );
}
