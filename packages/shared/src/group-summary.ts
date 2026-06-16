/**
 * Group-summary contract — shared between server (the validated aggregate
 * engine) and web (the renderer + config UI). The server is the source of
 * truth for the whitelist; the web config UI lists ONLY these ops (a
 * sibling-site of the server `AGGREGATIONS` set), and the renderer consumes
 * the response shape below.
 *
 * See `docs/superpowers/plans/2026-06-16-phase-6-views.md` — `## Threat model —
 * group-summary endpoint` (mitigations 1–8) and `## Contract`.
 */

/**
 * The CLOSED set of aggregation operators. Mirrors `filter-compile.ts`'s
 * `OPERATORS` set: a client-supplied op is rejected unless it is in this set,
 * and each op maps server-side to a FIXED parametrized SQL fragment. NO op
 * string ever reaches SQL un-mapped (mitigation 1). Adding an op here is the
 * ONLY way to widen the surface — additive-only.
 */
export const AGGREGATIONS = ['count', 'pct_matching', 'avg', 'sum', 'distribution'] as const;

export type Aggregation = (typeof AGGREGATIONS)[number];

/**
 * One per-group summary statistic.
 * - `count` needs neither `field` nor `value`.
 * - `avg` / `sum` / `distribution` require `field`.
 * - `pct_matching` requires both `field` and `value` (the % of the group whose
 *   `field` equals `value`); `value` flows to SQL as a BOUND param, never
 *   interpolated (mitigation 2).
 */
export interface AggregateSpec {
  op: Aggregation;
  field?: string;
  value?: string;
}

/** One value in a `distribution` aggregate (capped at MAX_DISTRIBUTION_BUCKETS, mitigation 8). */
export interface DistributionBucket {
  value: string;
  count: number;
}

/**
 * One group in the summary. `value` is the group field's value (or `null` for
 * the ungrouped bucket — documents missing/empty on the groupBy field).
 * `aggregates` is keyed by a stable spec-key (`<op>` | `<op>:<field>` |
 * `pct_matching:<field>:<value>`) → either a scalar number or, for a
 * `distribution` op, a `DistributionBucket[]`.
 */
export interface GroupSummaryRow {
  value: string | null;
  count: number;
  aggregates: Record<string, number | DistributionBucket[]>;
}

export interface GroupSummaryResponse {
  groups: GroupSummaryRow[];
  /** The "no group" bucket (groupBy field missing/empty); null when no such docs. */
  ungrouped: GroupSummaryRow | null;
  /** true when the distinct group count hit MAX_GROUPS (mitigation 4). */
  truncated: boolean;
}

/**
 * Per-view config for a `grouped-list` view (Phase 6 Cluster 2). Stored in
 * `views.settings` (the permissive `z.record(z.unknown())` JSON column), read by
 * the 2b renderer. `groupBy` is the frontmatter field rows are grouped on;
 * `aggregates` are the per-group summary stats (the engine caps at 10);
 * `rowLayout` composes each row from the document's fields.
 */
export interface GroupedListSettings {
  /** The group field key (a frontmatter key or a column like `status`). */
  groupBy: string;
  /** The per-group summary stats shown in each group header (max 10). */
  aggregates: AggregateSpec[];
  /** Composed-row config: the primary line, an optional subtitle, and extra fields. */
  rowLayout: { primary: string; subtitle?: string; fields: string[] };
}
