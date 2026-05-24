import type { Field, FieldType } from '../../lib/api/fields.ts';
import type { View } from '../../lib/api/views.ts';

export interface Column {
  key: string;
  label: string;
  source: 'builtin' | 'field';
  fieldType?: FieldType;
  fieldOptions?: string[] | null;
}

const BUILTIN_COLUMNS: Column[] = [
  { key: 'title',      label: 'Title',   source: 'builtin' },
  { key: 'status',     label: 'Status',  source: 'builtin' },
  { key: 'updated_at', label: 'Updated', source: 'builtin' },
];

const DEFAULT_VISIBLE_KEYS = BUILTIN_COLUMNS.map((c) => c.key);

export function mergeColumns(fields: Field[], _view: View | null): Column[] {
  const fieldCols: Column[] = [...fields]
    .sort((a, b) => a.order - b.order)
    .map((f) => ({
      key: f.key,
      label: f.label ?? f.key,
      source: 'field',
      fieldType: f.type,
      fieldOptions: f.options,
    }));
  return [...BUILTIN_COLUMNS, ...fieldCols];
}

export function applyColumnOrder(cols: Column[], order: string[] | null): Column[] {
  if (!order || order.length === 0) return cols;
  const byKey = new Map(cols.map((c) => [c.key, c]));
  const ordered: Column[] = [];
  for (const key of order) {
    const col = byKey.get(key);
    if (col) {
      ordered.push(col);
      byKey.delete(key);
    }
  }
  // Append columns not in the order array (newly-added fields).
  for (const col of cols) {
    if (byKey.has(col.key)) ordered.push(col);
  }
  return ordered;
}

export function effectiveVisibleKeys(cols: Column[], view: View | null): string[] {
  if (!view?.visibleFields || view.visibleFields.length === 0) return DEFAULT_VISIBLE_KEYS;
  const valid = new Set(cols.map((c) => c.key));
  return view.visibleFields.filter((k) => valid.has(k));
}
