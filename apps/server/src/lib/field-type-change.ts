export const FIELD_TYPES = [
  'string', 'text', 'number', 'boolean', 'date', 'datetime',
  'select', 'multi_select', 'user_ref', 'url', 'document_ref',
  'currency', 'relation',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export type TypeChangeResult =
  | { ok: true }
  | { ok: false; reason: string };

const COMPATIBLE_PAIRS: ReadonlySet<string> = new Set([
  // bidirectional string-family
  'string→text', 'text→string',
  // bidirectional number ↔ currency
  'number→currency', 'currency→number',
]);

export function validateTypeChange(oldType: FieldType, newType: FieldType): TypeChangeResult {
  if (oldType === newType) return { ok: true };
  // any → text is always safe; text accepts any stringifiable value.
  if (newType === 'text') return { ok: true };
  const key = `${oldType}→${newType}`;
  if (COMPATIBLE_PAIRS.has(key)) return { ok: true };
  return {
    ok: false,
    reason: `Cannot change ${oldType} → ${newType}. Allowed: string ↔ text, number ↔ currency, any → text. Delete the column and recreate it with the new type to migrate values manually.`,
  };
}
