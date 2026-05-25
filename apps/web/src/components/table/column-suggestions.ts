import type { Field, FieldType } from '../../lib/api/fields.ts';

export interface ColumnSuggestion {
  key: string;
  sample: unknown;
  inferredType: FieldType;
}

interface DocLike {
  frontmatter: unknown;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T.*)?$/;

function inferType(value: unknown): FieldType {
  if (Array.isArray(value)) return 'multi_select';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string' && ISO_DATE_RE.test(value)) return 'date';
  return 'string';
}

export function columnSuggestions(docs: DocLike[], fields: Field[]): ColumnSuggestion[] {
  const pinned = new Set(fields.map((f) => f.key));
  const seen = new Map<string, unknown>();

  for (const d of docs) {
    const fm = (d.frontmatter ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(fm)) {
      if (pinned.has(k)) continue;
      const existing = seen.get(k);
      if (existing == null && v != null) seen.set(k, v);
      else if (!seen.has(k)) seen.set(k, v);
    }
  }

  const out: ColumnSuggestion[] = [];
  for (const [key, sample] of seen) {
    out.push({ key, sample, inferredType: inferType(sample) });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}
