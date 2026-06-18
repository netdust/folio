import type { AggregateSpec } from '@folio/shared';
import { describe, expect, it } from 'vitest';
import { groupSummaryPath } from './group-summary.ts';

// Tier A — the hook serializes groupBy + aggregates (JSON) + filter (JSON) into
// the exact query string the L.1 route reads (c.req.query('groupBy'),
// JSON.parse(c.req.query('aggregates')), JSON.parse(c.req.query('filter'))). A
// wrong serialization silently mis-aggregates (wrong/empty stats) with no error,
// so the URL contract is a real, falsifiable behavioral contract — pure
// branching/encoding logic, tested directly off the path builder.
describe('groupSummaryPath', () => {
  const aggregates: AggregateSpec[] = [{ op: 'count' }];

  it('builds the table-scoped path with encoded groupBy + aggregates JSON', () => {
    const path = groupSummaryPath('ws', 'proj', 'tbl', {
      groupBy: 'status',
      aggregates,
    });
    // table-scoped path (per-table grouped-list view), mirrors useDocuments
    expect(path.startsWith('/api/v1/w/ws/p/proj/t/tbl/documents/group-summary?')).toBe(true);
    expect(path).toContain('groupBy=status');
    // aggregates flow as encodeURIComponent(JSON.stringify(...)) — the route
    // does JSON.parse on the raw query value.
    expect(path).toContain(`aggregates=${encodeURIComponent(JSON.stringify(aggregates))}`);
  });

  it('encodes the optional filter as a JSON string when present', () => {
    const filter = { priority: { $eq: 'high' } };
    const path = groupSummaryPath('ws', 'proj', 'tbl', {
      groupBy: 'status',
      aggregates,
      filter,
    });
    expect(path).toContain(`filter=${encodeURIComponent(JSON.stringify(filter))}`);
  });

  it('omits filter from the query string when absent', () => {
    const path = groupSummaryPath('ws', 'proj', 'tbl', {
      groupBy: 'status',
      aggregates,
    });
    expect(path).not.toContain('filter=');
  });

  it('defaults type to work_item but carries an explicit type override', () => {
    const def = groupSummaryPath('ws', 'proj', 'tbl', { groupBy: 'status', aggregates });
    expect(def).toContain('type=work_item');
    const page = groupSummaryPath('ws', 'proj', 'tbl', {
      groupBy: 'status',
      aggregates,
      type: 'page',
    });
    expect(page).toContain('type=page');
  });

  it('round-trips through the JSON.parse the route performs', () => {
    // Negative/adversarial: an aggregate carrying a field+value (pct_matching)
    // must survive encode → decode unchanged, or the server mis-parses the spec.
    const specs: AggregateSpec[] = [
      { op: 'pct_matching', field: 'status', value: 'done' },
      { op: 'avg', field: 'estimate' },
    ];
    const path = groupSummaryPath('ws', 'proj', 'tbl', { groupBy: 'status', aggregates: specs });
    const url = new URL(`http://x${path}`);
    expect(JSON.parse(url.searchParams.get('aggregates') ?? '')).toEqual(specs);
  });
});
