import { describe, it, expect } from 'vitest';
import type { Field } from '../../lib/api/fields.ts';
import type { View } from '../../lib/api/views.ts';
import { mergeColumns, applyColumnOrder, effectiveVisibleKeys } from './columns.ts';

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
