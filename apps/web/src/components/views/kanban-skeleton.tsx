import { Skeleton } from '../ui/skeleton.tsx';

export function KanbanSkeleton({ columns = 3, cardsPerColumn = 2 }: { columns?: number; cardsPerColumn?: number }) {
  return (
    <div className="flex h-full gap-3 overflow-x-auto px-[22px] py-2" aria-busy>
      {Array.from({ length: columns }, (_, c) => (
        <div key={c} className="flex w-[280px] shrink-0 flex-col">
          <div className="mb-2 flex items-center gap-2 px-1">
            <Skeleton width={8} height={8} rounded="pill" />
            <Skeleton width={80} height={14} />
            <Skeleton width={20} height={14} />
          </div>
          <div className="flex flex-col gap-2 rounded-md p-1">
            {Array.from({ length: cardsPerColumn }, (_, i) => (
              <div key={i} className="rounded-md border border-border-light bg-shell px-3 py-2">
                <Skeleton width="80%" height={14} />
                <Skeleton className="mt-2" width="40%" height={11} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
