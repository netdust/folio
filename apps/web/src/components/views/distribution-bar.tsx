import type { DistributionBucket } from '@folio/shared';

// A small, stable palette for distribution segments. The bar is purely
// presentational — it visualizes the per-group breakdown the endpoint already
// computed (never re-derived client-side).
const SEGMENT_COLORS = [
  '#6EAFFF',
  '#F0A442',
  '#7DD3A0',
  '#C792EA',
  '#FF8A8A',
  '#F6C453',
  '#79D0E0',
  '#B0BEC5',
];

interface Props {
  buckets: DistributionBucket[];
}

/**
 * The colored per-group breakdown bar. Each bucket becomes a segment whose width
 * is proportional to its share of the group total. The values come straight from
 * the (already-hardened) group-summary endpoint — this component only paints.
 */
export function DistributionBar({ buckets }: Props) {
  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  if (total === 0 || buckets.length === 0) return null;

  return (
    <div className="flex flex-col gap-1" data-testid="distribution-bar">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-card">
        {buckets.map((b, i) => {
          const pct = (b.count / total) * 100;
          return (
            <div
              key={b.value}
              data-bucket={b.value}
              title={`${b.value}: ${b.count}`}
              style={{
                width: `${pct}%`,
                backgroundColor: SEGMENT_COLORS[i % SEGMENT_COLORS.length],
              }}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-fg-3">
        {buckets.map((b, i) => (
          <span key={b.value} className="inline-flex items-center gap-1">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: SEGMENT_COLORS[i % SEGMENT_COLORS.length] }}
            />
            {b.value} · {b.count}
          </span>
        ))}
      </div>
    </div>
  );
}
