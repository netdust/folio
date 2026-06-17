import type { GroupedListSettings } from '@folio/shared';
import { useState } from 'react';
import { useFields } from '../../lib/api/fields.ts';
import { AggregateBuilder } from './aggregate-builder.tsx';

interface Props {
  wslug: string;
  pslug: string;
  tslug: string;
  /** The assembled grouped-list config (controlled). */
  value: GroupedListSettings;
  onChange: (next: GroupedListSettings) => void;
}

/**
 * The default grouped-list config for a freshly-created `list` view: group by
 * `status` (the built-in), one `count` aggregate (so a group header shows at
 * least "N items"), and a `title` primary row line with no extra body fields.
 * The renderer (L.3) defaults to the same shape when `settings` is absent, so a
 * created view and an un-configured view look identical.
 */
export function defaultGroupedListSettings(): GroupedListSettings {
  return {
    groupBy: 'status',
    aggregates: [{ op: 'count' }],
    rowLayout: { primary: 'title', fields: [] },
  };
}

const selectClass =
  'mt-1 block w-full rounded-md border border-border-light bg-shell px-3 py-2 text-fg input-focus';

/**
 * The `list`-type config block for the new-view sheet (and an edit-view
 * affordance). Driven by `useFields`: a group-by picker and an aggregate
 * builder, assembled into a `GroupedListSettings`. A `list` view renders as a
 * grouped TABLE (it uses the table's COLUMNS), so there is no card row-layout
 * picker — `defaultGroupedListSettings()` keeps a minimal `rowLayout` only for
 * back-compat with the (required) shared type and existing saved views.
 *
 * The aggregate builder is the shared `AggregateBuilder` (also mounted by the
 * edit-active-view `ListControls`), so the `AGGREGATIONS` whitelist and the I-2
 * incomplete-spec pruning live in ONE place — never duplicated here.
 */
export function GroupedListConfig({ wslug, pslug, tslug, value, onChange }: Props) {
  const { data: fields } = useFields(wslug, pslug, tslug);
  const allFields = fields ?? [];
  // Mirror the kanban group-by exclusion: a multi_select field can't be grouped on.
  const groupableFields = allFields.filter((f) => f.type !== 'multi_select');

  // FIX I-2: the aggregate rows are pruned to complete specs by the shared
  // AggregateBuilder before they reach here, so `aggregates` is always a safe
  // payload. We keep our own copy so a group-by edit re-emits the latest pruned
  // aggregates rather than resurrecting an incomplete spec.
  const [aggregates, setAggregates] = useState(value.aggregates);

  function emitAggregates(next: typeof aggregates) {
    setAggregates(next);
    onChange({ ...value, aggregates: next });
  }

  return (
    <div className="space-y-4">
      {/* Group-by picker */}
      <div>
        <label htmlFor="gl-group-by" className="block text-sm font-medium text-fg">
          Group by
        </label>
        <select
          id="gl-group-by"
          className={selectClass}
          value={value.groupBy}
          onChange={(e) => onChange({ ...value, groupBy: e.target.value, aggregates })}
        >
          <option value="status">Status</option>
          {groupableFields.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label ?? f.key}
            </option>
          ))}
        </select>
      </div>

      {/* Aggregate builder (shared) */}
      <AggregateBuilder
        fields={allFields}
        aggregates={value.aggregates}
        onChange={emitAggregates}
      />
    </div>
  );
}
