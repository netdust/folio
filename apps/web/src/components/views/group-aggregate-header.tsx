import type { AggregateSpec, DistributionBucket, GroupSummaryRow } from '@folio/shared';
import { DistributionBar } from './distribution-bar.tsx';

/**
 * The summary-row spec-key for an aggregate. MUST mirror the SERVER's `specKey`
 * (apps/server/src/services/group-summary.ts) exactly — the endpoint keys the
 * `aggregates` map by this string, so a drift here silently reads `undefined`:
 *   count            → 'count'
 *   pct_matching     → 'pct_matching:<field>:<value>'
 *   avg|sum|distrib. → '<op>:<field>'
 */
export function aggregateKey(spec: AggregateSpec): string {
  if (spec.op === 'count') return 'count';
  if (spec.op === 'pct_matching') return `pct_matching:${spec.field}:${spec.value}`;
  return `${spec.op}:${spec.field}`;
}

/** A short human label for a scalar aggregate chip. */
function aggregateLabel(spec: AggregateSpec): string {
  switch (spec.op) {
    case 'count':
      return 'items';
    case 'avg':
      return `avg ${spec.field}`;
    case 'sum':
      return `sum ${spec.field}`;
    case 'pct_matching':
      return `${spec.field} = ${spec.value}`;
    default:
      return spec.op;
  }
}

function isDistribution(v: number | DistributionBucket[] | undefined): v is DistributionBucket[] {
  return Array.isArray(v);
}

function formatScalar(n: number): string {
  // Trim trailing zeros on non-integers (avg can be fractional); leave integers as-is.
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

interface Props {
  /** Stable testid suffix (the group value, or `__nogroup__`). */
  groupKey: string;
  /** The summary row from the endpoint — the SOURCE OF TRUTH for count + aggregates. */
  row: GroupSummaryRow;
  /** The configured aggregates (drives which stats render, in order). */
  aggregates: AggregateSpec[];
}

/**
 * The RIGHT side of a grouped-table section header: the configured aggregate
 * stats (scalar chips + any distribution bar). Every number here comes from
 * `row` (the group-summary endpoint), NEVER from a client count of the loaded
 * rows — that is the page-2-bug guard.
 *
 * The group label + full-set count are owned by the SOLE consumer
 * (GroupHeaderRow) on its own LEFT side, so they are NOT rendered here.
 */
export function GroupAggregateHeader({ groupKey, row, aggregates }: Props) {
  const distributions = aggregates.filter((a) => a.op === 'distribution');
  const scalars = aggregates.filter((a) => a.op !== 'distribution' && a.op !== 'count');

  return (
    <div
      data-testid={`group-header-${groupKey}`}
      className="flex flex-col gap-1.5 border-b border-border-light px-1 pb-2"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        {scalars.map((spec) => {
          const k = aggregateKey(spec);
          const val = row.aggregates[k];
          if (isDistribution(val) || val === undefined) return null;
          return (
            <span key={k} className="text-xs text-fg-3" data-aggregate={k}>
              {aggregateLabel(spec)}: {formatScalar(val)}
            </span>
          );
        })}
      </div>
      {distributions.map((spec) => {
        const k = aggregateKey(spec);
        const val = row.aggregates[k];
        if (!isDistribution(val)) return null;
        return <DistributionBar key={k} buckets={val} />;
      })}
    </div>
  );
}
