import { Skeleton } from '../ui/skeleton.tsx';

/**
 * Loading placeholder for the grouped-list view: a few group sections, each with
 * a header line and a couple of row placeholders. Mirrors the rendered layout so
 * there is no jump when the data arrives.
 */
export function GroupedListSkeleton({
  groups = 3,
  rowsPerGroup = 2,
}: { groups?: number; rowsPerGroup?: number }) {
  return (
    <div
      className="flex flex-col gap-6 px-[22px] py-2"
      aria-busy
      data-testid="grouped-list-skeleton"
    >
      {Array.from({ length: groups }, (_, g) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static non-reordering skeleton group, index key is stable
        <div key={g} className="flex flex-col gap-2">
          <div className="flex items-center gap-3 border-b border-border-light px-1 pb-2">
            <Skeleton width={80} height={14} />
            <Skeleton width={40} height={12} />
          </div>
          {Array.from({ length: rowsPerGroup }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static non-reordering skeleton row, index key is stable
            <div key={i} className="rounded-md border border-border-light bg-shell px-3 py-2">
              <Skeleton width="60%" height={14} />
              <Skeleton className="mt-2" width="30%" height={11} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
