import { Skeleton } from '../ui/skeleton.tsx';

export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div role="list" className="flex flex-col" aria-busy>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="grid w-full grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-border-light px-4 py-2"
        >
          <Skeleton width="60%" height={14} />
          <Skeleton width={80} height={14} />
          <Skeleton width={50} height={14} />
        </div>
      ))}
    </div>
  );
}
