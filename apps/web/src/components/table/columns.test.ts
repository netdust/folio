import { describe, it, expect } from 'vitest';
import type { Field } from '../../lib/api/fields.ts';
import type { View } from '../../lib/api/views.ts';
import { mergeColumns, applyColumnOrder, effectiveVisibleKeys, gridTemplate, type Column } from './columns.ts';

const fields: Field[] = [
  { id: 'f1', key: 'amount',   type: 'currency',     label: 'Amount',   options: ['EUR'],       required: false, order: 0 },
  { id: 'f2', key: 'due_date', type: 'date',         label: 'Due',      options: null,          required: false, order: 10 },
  { id: 'f3', key: 'tags',     type: 'multi_select', label: 'Tags',     options: ['x', 'y'],    required: false, order: 20 },
];

describe('mergeColumns', () => {
  it('returns built-in columns even with no fields', () => {
    const cols = mergeColumns([], null);
    expect(cols.map((c) => c.key)).toEqual(['title', 'status', 'updated_at']);
  });

  it('appends one column per field after the built-ins', () => {
    const cols = mergeColumns(fields, null);
    expect(cols.map((c) => c.key)).toEqual(['title', 'status', 'updated_at', 'amount', 'due_date', 'tags']);
  });

  it('marks built-in vs field source correctly', () => {
    const cols = mergeColumns(fields, null);
    expect(cols.find((c) => c.key === 'title')!.source).toBe('builtin');
    expect(cols.find((c) => c.key === 'amount')!.source).toBe('field');
  });

  it('attaches field metadata onto field columns', () => {
    const cols = mergeColumns(fields, null);
    const amount = cols.find((c) => c.key === 'amount')!;
    expect(amount.fieldType).toBe('currency');
    expect(amount.fieldOptions).toEqual(['EUR']);
    expect(amount.label).toBe('Amount');
  });

  it('falls back to field key when label is null', () => {
    const cols = mergeColumns(
      [{ id: 'f4', key: 'no_label', type: 'string', label: null, options: null, required: false, order: 30 }],
      null,
    );
    expect(cols.find((c) => c.key === 'no_label')!.label).toBe('no_label');
  });

  it('sorts field columns by Field.order ascending', () => {
    const unsorted: Field[] = [
      { id: 'a', key: 'late',   type: 'string', label: null, options: null, required: false, order: 99 },
      { id: 'b', key: 'early',  type: 'string', label: null, options: null, required: false, order: 1 },
      { id: 'c', key: 'middle', type: 'string', label: null, options: null, required: false, order: 50 },
    ];
    const cols = mergeColumns(unsorted, null);
    expect(cols.slice(3).map((c) => c.key)).toEqual(['early', 'middle', 'late']);
  });

  // Views-UX round 2 (data-loss bug): a view's visibleFields can reference
  // frontmatter keys that were never PINNED as Fields (the `fields` table is
  // commonly empty — priority/assignee/due_date live only in document
  // frontmatter). Those keys MUST become synthetic columns, or
  // effectiveVisibleKeys drops them and the next column-toggle persists the
  // truncated set, silently destroying them. They also rendered blank
  // (table-cell returns null without a fieldType). The fix: synthesize a
  // column for any visible key present in the sampled docs, with an inferred
  // type so it renders.
  describe('synthetic columns for unpinned visible fields', () => {
    const docs = [
      { frontmatter: { priority: 'high', assignee: 'u1', due_date: '2026-01-01', score: 5 } },
    ];

    it('synthesizes a field column for a visible key present in docs but not pinned', () => {
      const view = { visibleFields: ['title', 'priority', 'assignee'] } as unknown as View;
      const cols = mergeColumns([], view, docs);
      const keys = cols.map((c) => c.key);
      expect(keys).toContain('priority');
      expect(keys).toContain('assignee');
      const pri = cols.find((c) => c.key === 'priority')!;
      expect(pri.source).toBe('field');
    });

    it('infers a renderable fieldType for the synthetic column (so the cell is not blank)', () => {
      const view = { visibleFields: ['due_date', 'score'] } as unknown as View;
      const cols = mergeColumns([], view, docs);
      expect(cols.find((c) => c.key === 'due_date')!.fieldType).toBe('date');
      expect(cols.find((c) => c.key === 'score')!.fieldType).toBe('number');
    });

    it('does NOT synthesize a column for a visible key absent from both fields and docs (deleted field)', () => {
      const view = { visibleFields: ['title', 'GONE'] } as unknown as View;
      const cols = mergeColumns([], view, docs);
      expect(cols.map((c) => c.key)).not.toContain('GONE');
    });

    it('prefers a pinned Field over synthesizing (no duplicate column)', () => {
      const view = { visibleFields: ['due_date'] } as unknown as View;
      const cols = mergeColumns(fields, view, docs); // `fields` pins due_date as a `date`
      const dueCols = cols.filter((c) => c.key === 'due_date');
      expect(dueCols).toHaveLength(1);
      expect(dueCols[0].label).toBe('Due'); // the pinned field's label, not a synthesized one
    });

    it('round-trips unpinned visible keys through effectiveVisibleKeys (no silent drop)', () => {
      const view = { visibleFields: ['title', 'priority', 'assignee', 'due_date'] } as unknown as View;
      const cols = mergeColumns([], view, docs);
      // The whole point: these survive instead of collapsing to just the built-ins.
      expect(effectiveVisibleKeys(cols, view)).toEqual(['title', 'priority', 'assignee', 'due_date']);
    });

    it('is a no-op when docs are omitted (back-compat for callers without data)', () => {
      const view = { visibleFields: ['title', 'priority'] } as unknown as View;
      const cols = mergeColumns([], view);
      expect(cols.map((c) => c.key)).toEqual(['title', 'status', 'updated_at']);
    });
  });
});

describe('applyColumnOrder', () => {
  it('returns input unchanged when order is null', () => {
    const cols = mergeColumns(fields, null);
    const out = applyColumnOrder(cols, null);
    expect(out).toEqual(cols);
  });

  it('returns input unchanged when order is empty', () => {
    const cols = mergeColumns(fields, null);
    const out = applyColumnOrder(cols, []);
    expect(out).toEqual(cols);
  });

  it('reorders columns to match the order array, appending un-listed', () => {
    const cols = mergeColumns(fields, null);
    const out = applyColumnOrder(cols, ['amount', 'title']);
    expect(out.map((c) => c.key)).toEqual(['amount', 'title', 'status', 'updated_at', 'due_date', 'tags']);
  });

  it('skips keys in the order array that are not in the column list (deleted fields)', () => {
    const cols = mergeColumns(fields, null);
    const out = applyColumnOrder(cols, ['amount', 'GONE', 'title']);
    expect(out.map((c) => c.key)).toEqual(['amount', 'title', 'status', 'updated_at', 'due_date', 'tags']);
  });
});

describe('effectiveVisibleKeys', () => {
  it('returns built-ins by default when view is null', () => {
    expect(effectiveVisibleKeys(mergeColumns(fields, null), null)).toEqual(
      ['title', 'status', 'updated_at']
    );
  });

  it('returns built-ins when view.visibleFields is null', () => {
    const view = { visibleFields: null } as unknown as View;
    expect(effectiveVisibleKeys(mergeColumns(fields, null), view)).toEqual(
      ['title', 'status', 'updated_at']
    );
  });

  it('returns built-ins when view.visibleFields is empty', () => {
    const view = { visibleFields: [] } as unknown as View;
    expect(effectiveVisibleKeys(mergeColumns(fields, null), view)).toEqual(
      ['title', 'status', 'updated_at']
    );
  });

  it("returns the view's visibleFields exactly when set", () => {
    const view = { visibleFields: ['title', 'amount'] } as unknown as View;
    expect(effectiveVisibleKeys(mergeColumns(fields, null), view)).toEqual(['title', 'amount']);
  });

  it('drops any visible keys that no longer exist as columns', () => {
    const view = { visibleFields: ['title', 'GONE', 'amount'] } as unknown as View;
    expect(effectiveVisibleKeys(mergeColumns(fields, null), view)).toEqual(['title', 'amount']);
  });
});

describe('gridTemplate', () => {
  const titleCol: Column = { key: 'title', label: 'Title', source: 'builtin' };
  const statusCol: Column = { key: 'status', label: 'Status', source: 'builtin' };
  const tagsCol: Column = { key: 'tags', label: 'Tags', source: 'field', fieldType: 'multi_select' };

  it('returns a single track when given one column', () => {
    expect(gridTemplate([titleCol])).toBe('280px');
  });

  it('emits one track per column with NO 1fr spacer (columns sit flush)', () => {
    // Phase 2 / Bug E fix: the 1fr spacer that used to sit between the
    // second-to-last and last columns is gone. Last column now sits flush
    // against the rest; trailing whitespace goes to the right of the table.
    const tpl = gridTemplate([titleCol, statusCol, tagsCol]);
    expect(tpl).toBe('280px 140px 220px');
    expect(tpl).not.toContain('1fr');
  });

  it('returns empty string when given no columns', () => {
    expect(gridTemplate([])).toBe('');
  });
});
