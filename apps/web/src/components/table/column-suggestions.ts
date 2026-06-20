import type { Field, FieldType } from '../../lib/api/fields.ts';

export interface ColumnSuggestion {
  key: string;
  sample: unknown;
  inferredType: FieldType;
  /**
   * For `multi_select` suggestions only: the distinct member values seen
   * across all docs, sorted. The server requires non-empty options for
   * multi_select, so a suggestion pinned without these 422s — deriving them
   * from the data makes the pinned column valid and ready to use.
   */
  options?: string[];
}

interface DocLike {
  frontmatter: unknown;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T.*)?$/;

export function inferType(value: unknown): FieldType {
  if (Array.isArray(value)) return 'multi_select';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string' && ISO_DATE_RE.test(value)) return 'date';
  return 'string';
}

export function columnSuggestions(docs: DocLike[], fields: Field[]): ColumnSuggestion[] {
  const pinned = new Set(fields.map((f) => f.key));
  const seen = new Map<string, unknown>();
  // For array-valued keys, accumulate the distinct member values across ALL
  // docs so a multi_select suggestion can carry valid options (else it 422s
  // on pin — the server requires non-empty options for multi_select).
  const optionValues = new Map<string, Set<string>>();

  for (const d of docs) {
    const fm = (d.frontmatter ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(fm)) {
      if (pinned.has(k)) continue;
      const existing = seen.get(k);
      if (existing == null && v != null) seen.set(k, v);
      else if (!seen.has(k)) seen.set(k, v);
      if (Array.isArray(v)) {
        const set = optionValues.get(k) ?? new Set<string>();
        for (const member of v) {
          if (typeof member === 'string' && member !== '') set.add(member);
        }
        optionValues.set(k, set);
      }
    }
  }

  const out: ColumnSuggestion[] = [];
  for (const [key, sample] of seen) {
    const inferredType = inferType(sample);
    const suggestion: ColumnSuggestion = { key, sample, inferredType };
    if (inferredType === 'multi_select') {
      const opts = [...(optionValues.get(key) ?? new Set<string>())].sort((a, b) =>
        a.localeCompare(b),
      );
      // Only attach when there is at least one option — an array field whose
      // members are all empty/non-string yields no valid options, and a
      // multi_select with [] still 422s, so leave it for the picker to handle.
      if (opts.length > 0) suggestion.options = opts;
    }
    out.push(suggestion);
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}
