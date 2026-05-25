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
  if (!view?.visibleFields || view.visibleFields.length === 0) return [...DEFAULT_VISIBLE_KEYS];
  const valid = new Set(cols.map((c) => c.key));
  return view.visibleFields.filter((k) => valid.has(k));
}

/** Per-column fixed widths so header and body align on horizontal scroll. */
const BUILTIN_WIDTHS: Record<string, number> = {
  title: 280,
  status: 140,
  updated_at: 100,
};

const FIELD_WIDTHS: Partial<Record<FieldType, number>> = {
  string: 200,
  text: 240,
  number: 120,
  currency: 120,
  boolean: 80,
  date: 140,
  datetime: 160,
  select: 160,
  multi_select: 220,
  user_ref: 200,
  url: 240,
  document_ref: 200,
};

export function columnWidth(col: Column): number {
  if (col.source === 'builtin') return BUILTIN_WIDTHS[col.key] ?? 160;
  if (col.fieldType) return FIELD_WIDTHS[col.fieldType] ?? 160;
  return 160;
}

/** Build a grid-template-columns string from the visible columns.
 *  All columns keep their fixed widths and sit flush against each other.
 *  Trailing whitespace lives to the right of the last column (in the
 *  scroll container). The earlier `1fr` spacer that pushed the last
 *  column to the right edge was removed because it left a visual gap
 *  between the last column header label and the cells in the last
 *  column — Bug E (2026-05-26). */
export function gridTemplate(columns: Column[]): string {
  return columns.map((c) => `${columnWidth(c)}px`).join(' ');
}
