import type { FilterClauseUrl } from '../../lib/api/documents.ts';
import type { Field } from '../../lib/api/fields.ts';
import type { Status } from '../../lib/api/statuses.ts';
import { FilterAdd } from './filter-add.tsx';
import { FilterChip } from './filter-chip.tsx';

interface Props {
  clauses: FilterClauseUrl[];
  statuses: Status[];
  pinnedFields: Field[];
  onChange: (next: FilterClauseUrl[]) => void;
}

export function FilterBar({ clauses, statuses, pinnedFields, onChange }: Props) {
  const labelOf = (c: FilterClauseUrl): string => {
    if (c.kind === 'status') {
      return c.values.map((v) => statuses.find((s) => s.key === v)?.name ?? v).join(', ');
    }
    if (c.kind === 'labels') return c.values.join(', ');
    if (c.kind === 'priority' || c.kind === 'assignee' || c.kind === 'updated_since')
      return c.value;
    if (c.kind === 'field') return c.value;
    return '';
  };

  const keyOf = (c: FilterClauseUrl): string => {
    if (c.kind === 'updated_since') return 'updated since';
    // A generic field clause is identified by its field key + operator so two
    // field filters (e.g. role / diet_tags) render as distinct chips.
    if (c.kind === 'field') return c.key;
    return c.kind;
  };

  // Distinct React key per clause — `kind` alone collides for multiple `field`
  // clauses; suffix the field key so each field filter is its own chip.
  const reactKeyOf = (c: FilterClauseUrl): string =>
    c.kind === 'field' ? `field:${c.key}` : c.kind;

  // Remove the exact clause (a `field` clause matches on its key, not just kind).
  const remove = (target: FilterClauseUrl) => {
    onChange(
      clauses.filter((c) =>
        target.kind === 'field' && c.kind === 'field'
          ? c.key !== target.key
          : c.kind !== target.kind,
      ),
    );
  };

  return (
    <div data-testid="filter-bar" className="flex flex-wrap items-center gap-1.5 py-2">
      {clauses.map((c) => (
        <FilterChip
          key={reactKeyOf(c)}
          filterKey={keyOf(c)}
          value={labelOf(c)}
          onRemove={() => remove(c)}
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
