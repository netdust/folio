import { Skeleton } from '../ui/skeleton.tsx';

export function WikiSkeleton() {
  // 4 root nodes, 2 with one nested child.
  const rows = [
    { width: 160, depth: 0 },
    { width: 200, depth: 0 },
    { width: 140, depth: 1 },
    { width: 180, depth: 0 },
    { width: 210, depth: 1 },
    { width: 150, depth: 0 },
  ];
  return (
    <ul className="flex flex-col" aria-busy>
      {rows.map((r, i) => (
        <li
          key={i}
          className="grid grid-cols-[24px_1fr] items-center gap-1 py-1 pr-2"
          style={{ paddingLeft: `${r.depth * 16}px` }}
        >
          <Skeleton width={12} height={12} rounded="sm" />
          <Skeleton width={r.width} height={14} />
        </li>
      ))}
    </ul>
  );
}
