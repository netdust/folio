import type { AggregateSpec, GroupSummaryRow } from '@folio/shared';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { GroupAggregateHeader } from './group-aggregate-header.tsx';

interface Props {
  /** The group's display label (the group value, e.g. "VAD vzw"). */
  label: string;
  /** The frontmatter field rows are grouped on, e.g. "status" / "organisatie".
   *  Rendered uppercase as the section prefix ("ORGANISATIE ·"). */
  groupBy: string;
  /** The summary row from the endpoint — the SOURCE OF TRUTH for count + aggregates. */
  row: GroupSummaryRow;
  /** The configured aggregates (drives which stats render, in order). */
  aggregates: AggregateSpec[];
  /** Whether this group's data rows are currently collapsed. */
  collapsed: boolean;
  /** Toggle collapse/expand for this group. */
  onToggle: () => void;
}

/**
 * A full-width group section header for the grouped-TABLE list view. It spans
 * the table columns: the LEFT owns the collapse chevron, the uppercase
 * field-name prefix, the group value, and the FULL-SET item count; the RIGHT
 * reuses {@link GroupAggregateHeader} for the scalar stats + distribution bar.
 *
 * Every number here comes from `row` (the group-summary endpoint), NEVER from a
 * client count of the loaded rows — that is the page-2-bug guard.
 *
 * Matches the TableView row model: a flex div (not a `<tr>`), `border-b`, and a
 * subtle `bg-card` to distinguish the header from data rows.
 */
export function GroupHeaderRow({ label, groupBy, row, aggregates, collapsed, onToggle }: Props) {
  // The aggregates the RIGHT side renders: everything EXCEPT `count` — the count
  // is owned by the LEFT side here, so we drop it to avoid doubling it.
  const rightAggregates = aggregates.filter((a) => a.op !== 'count');

  const Chevron = collapsed ? ChevronRight : ChevronDown;

  return (
    <div
      data-testid={`group-header-row-${groupBy}-${row.value ?? '__nogroup__'}`}
      className="flex w-full items-center gap-3 border-b border-border-light bg-card py-1.5"
    >
      {/* LEFT: chevron + field prefix · value · count */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand group' : 'Collapse group'}
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-fg-3 hover:bg-border-light hover:text-fg"
        >
          <Chevron className="h-4 w-4" />
        </button>
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-3">
            {groupBy}
          </span>
          <span className="text-fg-3">·</span>
          <span className="truncate text-sm font-medium text-fg">{label}</span>
          <span className="text-fg-3">·</span>
          <span className="text-xs text-fg-3">{row.count} items</span>
        </div>
      </div>

      {/* RIGHT: scalar stats + distribution bar (label/count owned by the LEFT). */}
      {rightAggregates.length > 0 ? (
        <div className="flex flex-shrink-0 items-center justify-end">
          <GroupAggregateHeader
            label=""
            groupKey={row.value ?? '__nogroup__'}
            row={row}
            aggregates={rightAggregates}
            showLabelAndCount={false}
          />
        </div>
      ) : null}
    </div>
  );
}
