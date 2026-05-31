import { describe, expect, test } from 'vitest';
import { buildColumns, type BoardColumn } from './board-grouping.ts';
import type { DocumentSummary } from '../../lib/api/documents.ts';

const doc = (id: string, fm: Record<string, unknown>, status: string | null = null): DocumentSummary =>
  ({ id, slug: id, type: 'work_item', title: id, status, parentId: null, frontmatter: fm, createdAt: '', updatedAt: '', lastTouchedAt: null, body: '', boardPosition: null });

describe('buildColumns', () => {
  test('group by status uses statuses + a parking lot only when non-empty', () => {
    const cols = buildColumns({
      docs: [doc('a', {}, 'todo'), doc('b', {}, null)],
      groupBy: 'status',
      field: null,
      statuses: [{ key: 'todo', name: 'Todo', color: '#000' } as never],
    });
    expect(cols.map((c) => c.value)).toEqual(['todo', null]);
    expect(cols.find((c) => c.value === 'todo')!.docIds).toEqual(['a']);
    expect(cols.find((c) => c.value === null)!.docIds).toEqual(['b']);
  });

  test('group by a select field uses field options as columns + unset', () => {
    const cols = buildColumns({
      docs: [doc('a', { priority: 'High' }), doc('b', {})],
      groupBy: 'priority',
      field: { key: 'priority', type: 'select', label: 'Priority', options: ['Low', 'High'] } as never,
      statuses: [],
    });
    expect(cols.map((c: BoardColumn) => c.value)).toEqual(['Low', 'High', null]);
    expect(cols.find((c) => c.value === 'High')!.docIds).toEqual(['a']);
    expect(cols.find((c) => c.value === null)!.docIds).toEqual(['b']);
  });

  test('group by a free-text field uses distinct observed values, alphabetical, + unset', () => {
    const cols = buildColumns({
      docs: [doc('a', { assignee: 'Zoe' }), doc('b', { assignee: 'Ann' }), doc('c', {})],
      groupBy: 'assignee',
      field: { key: 'assignee', type: 'user_ref', label: 'Assignee', options: null } as never,
      statuses: [],
    });
    expect(cols.map((c) => c.value)).toEqual(['Ann', 'Zoe', null]);
  });
});
