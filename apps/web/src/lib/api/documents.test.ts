import { describe, expect, it } from 'vitest';
import {
  type FilterClauseUrl,
  applyFrontmatterClauses,
  clausesToFilterJson,
  clausesToListParams,
} from './documents.ts';

// Tier A — the clauses → server `?filter=` JSON builder is pure branching logic
// that decides which frontmatter clauses go server-side. A wrong mapping ships
// silently-wrong filtered results (the bug this task fixes), so it carries a
// real, falsifiable contract.
describe('clausesToFilterJson', () => {
  it('maps a priority clause to a server-side $eq frontmatter filter', () => {
    const clauses: FilterClauseUrl[] = [{ kind: 'priority', value: 'high' }];
    expect(clausesToFilterJson(clauses)).toEqual({ priority: { $eq: 'high' } });
  });

  it('returns undefined when there are no frontmatter (server-filterable) clauses', () => {
    const clauses: FilterClauseUrl[] = [
      { kind: 'status', values: ['todo'] },
      { kind: 'assignee', value: 'alice' },
    ];
    expect(clausesToFilterJson(clauses)).toBeUndefined();
  });

  it('does NOT put labels in the server filter (no array-contains operator)', () => {
    // Labels stays a client-side post-filter — the compiler has no
    // array-contains operator, so a server-side $in/$eq would be WRONG, not
    // just absent. The honest contract: labels are excluded from the JSON.
    const clauses: FilterClauseUrl[] = [{ kind: 'labels', values: ['bug', 'urgent'] }];
    expect(clausesToFilterJson(clauses)).toBeUndefined();
  });

  it('combines a priority clause with non-server clauses, emitting only priority', () => {
    const clauses: FilterClauseUrl[] = [
      { kind: 'status', values: ['todo'] },
      { kind: 'priority', value: 'low' },
      { kind: 'labels', values: ['x'] },
    ];
    expect(clausesToFilterJson(clauses)).toEqual({ priority: { $eq: 'low' } });
  });
});

describe('clausesToListParams wires priority into the filter JSON', () => {
  it('carries the priority filter through listParams.filter', () => {
    const params = clausesToListParams([{ kind: 'priority', value: 'high' }]);
    expect(params.filter).toEqual({ priority: { $eq: 'high' } });
  });

  it('omits filter entirely when no frontmatter clause is present', () => {
    const params = clausesToListParams([{ kind: 'status', values: ['todo'] }]);
    expect(params.filter).toBeUndefined();
  });
});

describe('applyFrontmatterClauses (labels-only client post-filter after path 2b)', () => {
  const mk = (id: string, labels?: unknown, priority?: unknown) => ({
    id,
    slug: id,
    type: 'work_item' as const,
    title: id,
    status: null,
    boardPosition: null,
    parentId: null,
    frontmatter: {
      ...(labels !== undefined ? { labels } : {}),
      ...(priority !== undefined ? { priority } : {}),
    },
    createdAt: '',
    updatedAt: '',
    lastTouchedAt: null,
  });

  it('filters by labels with AND (contains-all) semantics', () => {
    const docs = [mk('a', ['bug', 'urgent']), mk('b', ['bug']), mk('c', [])];
    const out = applyFrontmatterClauses(docs, [{ kind: 'labels', values: ['bug', 'urgent'] }]);
    expect(out.map((d) => d.id)).toEqual(['a']);
  });

  it('does NOT post-filter priority anymore (priority is server-side now)', () => {
    // Regression guard for path 2b: priority must NOT be re-filtered client-side,
    // or it would double-filter / drop valid server rows on later pages.
    const docs = [mk('a', undefined, 'high'), mk('b', undefined, 'low')];
    const out = applyFrontmatterClauses(docs, [{ kind: 'priority', value: 'high' }]);
    expect(out.map((d) => d.id)).toEqual(['a', 'b']);
  });
});
