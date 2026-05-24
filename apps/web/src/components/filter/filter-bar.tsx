import type { FilterClauseUrl } from '../../lib/api/documents.ts';
import type { Status } from '../../lib/api/statuses.ts';
import type { Field } from '../../lib/api/fields.ts';
import { FilterChip } from './filter-chip.tsx';
import { FilterAdd } from './filter-add.tsx';

interface Props {
  clauses: FilterClauseUrl[];
  statuses: Status[];
  pinnedFields: Field[];
  onChange: (next: FilterClauseUrl[]) => void;
}

export function FilterBar({ clauses, statuses, pinnedFields, onChange }: Props) {
  const labelOf = (c: FilterClauseUrl): string => {
    if (c.kind === 'status') {
      return c.values
        .map((v) => statuses.find((s) => s.key === v)?.name ?? v)
        .join(', ');
    }
    if (c.kind === 'labels') return c.values.join(', ');
    if (c.kind === 'priority' || c.kind === 'assignee' || c.kind === 'updated_since')
      return c.value;
    return '';
  };

  const keyOf = (c: FilterClauseUrl): string =>
    c.kind === 'updated_since' ? 'updated since' : c.kind;

  const remove = (kind: FilterClauseUrl['kind']) => {
    onChange(clauses.filter((c) => c.kind !== kind));
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 py-2">
      {clauses.map((c) => (
        <FilterChip
          key={c.kind}
          filterKey={keyOf(c)}
          value={labelOf(c)}
          onRemove={() => remove(c.kind)}
        />
      ))}
      <FilterAdd
        statuses={statuses}
        pinnedFields={pinnedFields}
        existing={clauses}
        onAdd={(c) => onChange([...clauses, c])}
      />
    </div>
  );
}
