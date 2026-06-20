import type { Field } from '../../lib/api/fields.ts';
import { columnSuggestions } from '../table/column-suggestions.ts';

interface DocLike {
  frontmatter: unknown;
}

/**
 * The set of fields the filter bar can offer for a table — every PINNED field
 * plus a synthesized field for each frontmatter key that appears in the loaded
 * docs but was never formally pinned. This is what makes "filter on any column
 * you can see" work: an un-pinned column (just data, no `fields` row) still
 * becomes filterable, with its type inferred from the data (and multi_select
 * options derived from the distinct array members, like the column-suggestions
 * picker). Pinned fields win on a key collision (their explicit type/options are
 * authoritative over inference).
 */
export function filterableFields(pinnedFields: Field[], docs: DocLike[]): Field[] {
  const pinnedKeys = new Set(pinnedFields.map((f) => f.key));
  // columnSuggestions already skips pinned keys and derives type + options.
  const synthesized: Field[] = columnSuggestions(docs, pinnedFields)
    .filter((s) => !pinnedKeys.has(s.key))
    .map((s) => ({
      // Synthetic id — never written; the filter UI keys on `key`, not id.
      id: `inferred:${s.key}`,
      key: s.key,
      type: s.inferredType,
      label: null,
      options: s.options ?? null,
      required: false,
      order: 0,
    }));
  return [...pinnedFields, ...synthesized];
}
