import { describe, expect, it } from 'vitest';
import {
  type FilterClauseUrl,
  applyFrontmatterClauses,
  clausesToFilterJson,
  clausesToListParams,
  fieldFilterParam,
  fieldFilterValue,
  parseFilters,
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

  it('maps a labels clause to a server-side $contains frontmatter filter', () => {
    // Contract change (backlog #9): labels now go server-side via the compiler's
    // $contains array-membership operator, so they filter correctly across pages.
    const clauses: FilterClauseUrl[] = [{ kind: 'labels', values: ['bug', 'urgent'] }];
    expect(clausesToFilterJson(clauses)).toEqual({ labels: { $contains: ['bug', 'urgent'] } });
  });

  it('combines priority + labels clauses into one server filter', () => {
    const clauses: FilterClauseUrl[] = [
      { kind: 'status', values: ['todo'] },
      { kind: 'priority', value: 'low' },
      { kind: 'labels', values: ['x'] },
    ];
    expect(clausesToFilterJson(clauses)).toEqual({
      priority: { $eq: 'low' },
      labels: { $contains: ['x'] },
    });
  });

  it('maps a generic field clause ($eq) to a frontmatter filter on that key', () => {
    const clauses: FilterClauseUrl[] = [
      { kind: 'field', key: 'role', op: '$eq', value: 'performer' },
    ];
    expect(clausesToFilterJson(clauses)).toEqual({ role: { $eq: 'performer' } });
  });

  it('maps a generic field clause ($contains) for a multi_select key', () => {
    const clauses: FilterClauseUrl[] = [
      { kind: 'field', key: 'diet_tags', op: '$contains', value: 'veggie' },
    ];
    expect(clausesToFilterJson(clauses)).toEqual({ diet_tags: { $contains: ['veggie'] } });
  });

  it('combines multiple generic field clauses on different keys', () => {
    const clauses: FilterClauseUrl[] = [
      { kind: 'field', key: 'role', op: '$eq', value: 'performer' },
      { kind: 'field', key: 'org', op: '$eq', value: 'extern' },
    ];
    expect(clausesToFilterJson(clauses)).toEqual({
      role: { $eq: 'performer' },
      org: { $eq: 'extern' },
    });
  });
});

describe('parseFilters round-trips generic field clauses through the URL', () => {
  it('parses an $eq field clause from f_<key>=eq:<value>', () => {
    const out = parseFilters({ f_role: 'eq:performer' });
    expect(out).toContainEqual({ kind: 'field', key: 'role', op: '$eq', value: 'performer' });
  });

  it('parses a $contains field clause from f_<key>=has:<value>', () => {
    const out = parseFilters({ f_diet_tags: 'has:veggie' });
    expect(out).toContainEqual({
      kind: 'field',
      key: 'diet_tags',
      op: '$contains',
      value: 'veggie',
    });
  });

  it('round-trips via the encode helpers (encode → URL param → parse)', () => {
    const param = fieldFilterParam('org');
    const value = fieldFilterValue('$eq', 'extern');
    const out = parseFilters({ [param]: value });
    expect(out).toContainEqual({ kind: 'field', key: 'org', op: '$eq', value: 'extern' });
  });

  it('defaults to $eq when no op prefix is present (legacy/hand-typed URL)', () => {
    const out = parseFilters({ f_role: 'performer' });
    expect(out).toContainEqual({ kind: 'field', key: 'role', op: '$eq', value: 'performer' });
  });

  it('ignores non-field params and empty values', () => {
    const out = parseFilters({ status: 'todo', f_: 'x', f_role: '' });
    expect(out.some((c) => c.kind === 'field')).toBe(false);
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

describe('applyFrontmatterClauses (no-op after labels moved server-side, backlog #9)', () => {
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

  it('does NOT post-filter labels anymore (labels are server-side now)', () => {
    // Regression guard for backlog #9: labels must NOT be re-filtered client-side,
    // or it would double-filter and drop valid server rows that land on later pages
    // (the page-2 bug this task fixes — sibling of the priority page-2 fix). A doc
    // that matched the server filter must survive even when the client list is a
    // single page that does not itself contain every selected label.
    const docs = [mk('a', ['bug', 'urgent']), mk('b', ['bug']), mk('c', [])];
    const out = applyFrontmatterClauses(docs, [{ kind: 'labels', values: ['bug', 'urgent'] }]);
    expect(out.map((d) => d.id)).toEqual(['a', 'b', 'c']);
  });

  it('does NOT post-filter priority anymore (priority is server-side now)', () => {
    // Regression guard for path 2b: priority must NOT be re-filtered client-side,
    // or it would double-filter / drop valid server rows on later pages.
    const docs = [mk('a', undefined, 'high'), mk('b', undefined, 'low')];
    const out = applyFrontmatterClauses(docs, [{ kind: 'priority', value: 'high' }]);
    expect(out.map((d) => d.id)).toEqual(['a', 'b']);
  });
});

describe('clausesToListParams carries the labels filter (page-2 correctness)', () => {
  it('carries the labels $contains filter through listParams.filter', () => {
    const params = clausesToListParams([{ kind: 'labels', values: ['bug'] }]);
    expect(params.filter).toEqual({ labels: { $contains: ['bug'] } });
  });
});
