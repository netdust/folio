import type { DocumentSummary } from '../../lib/api/documents.ts';
import type { Field } from '../../lib/api/fields.ts';
import type { Status } from '../../lib/api/statuses.ts';

export interface BoardColumn {
  value: string | null; // grouping value; null = "unset" column
  label: string;
  color?: string; // status dot color, when grouping by status
  docIds: string[];
}

interface Args {
  docs: DocumentSummary[];
  groupBy: string; // 'status' or a field key
  field: Field | null; // field def when grouping by a field
  statuses: Status[];
}

export function buildColumns({ docs, groupBy, field, statuses }: Args): BoardColumn[] {
  if (groupBy === 'status') {
    const cols: BoardColumn[] = statuses.map((s) => ({ value: s.key, label: s.name, color: s.color, docIds: [] }));
    const byKey = new Map(cols.map((c) => [c.value, c]));
    const unset: BoardColumn = { value: null, label: 'No status', docIds: [] };
    for (const d of docs) {
      const c = d.status && byKey.has(d.status) ? byKey.get(d.status)! : unset;
      c.docIds.push(d.id);
    }
    return unset.docIds.length > 0 ? [...cols, unset] : cols;
  }

  const valueOf = (d: DocumentSummary): string | null => {
    const v = (d.frontmatter as Record<string, unknown>)[groupBy];
    if (v === null || v === undefined || v === '') return null;
    return String(v);
  };

  let values: string[];
  if (field && field.type === 'select' && field.options && field.options.length > 0) {
    values = [...field.options];
  } else {
    const seen = new Set<string>();
    for (const d of docs) {
      const v = valueOf(d);
      if (v !== null) seen.add(v);
    }
    values = [...seen].sort((a, b) => a.localeCompare(b));
  }

  const cols: BoardColumn[] = values.map((v) => ({ value: v, label: v, docIds: [] }));
  const byVal = new Map(cols.map((c) => [c.value, c]));
  const unset: BoardColumn = { value: null, label: 'Unset', docIds: [] };
  for (const d of docs) {
    const v = valueOf(d);
    const c = v !== null && byVal.has(v) ? byVal.get(v)! : unset;
    c.docIds.push(d.id);
  }
  return unset.docIds.length > 0 ? [...cols, unset] : cols;
}
