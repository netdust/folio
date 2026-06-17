import { AGGREGATIONS, type AggregateSpec, type GroupedListSettings } from '@folio/shared';
import { useState } from 'react';
import { useFields } from '../../lib/api/fields.ts';
import { Button } from '../ui/button.tsx';

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
const inputClass = selectClass;

/**
 * The `list`-type config block for the new-view sheet (and an edit-view
 * affordance). Driven by `useFields`: a group-by picker and an aggregate
 * builder, assembled into a `GroupedListSettings`. A `list` view renders as a
 * grouped TABLE (it uses the table's COLUMNS), so there is no card row-layout
 * picker — `defaultGroupedListSettings()` keeps a minimal `rowLayout` only for
 * back-compat with the (required) shared type and existing saved views.
 *
 * The aggregation `<select>` maps over the shared `AGGREGATIONS` whitelist — a
 * SIBLING-SITE of the server's `AGGREGATIONS` set (the engine rejects any op
 * outside it). Never hardcode a divergent list here.
 */
/**
 * FIX I-2: a non-`count` op leaves `field` empty (and `pct_matching` leaves
 * `value` empty) until the user picks one. Those incomplete specs make the
 * server's group-summary endpoint 422. Filter them out of the EMITTED settings
 * so a view is never created/saved with a broken aggregate. The incomplete row
 * still renders in the UI (driven by the controlled `value`) so the user can
 * finish it — only the emitted `onChange` value is pruned.
 */
function isCompleteSpec(spec: AggregateSpec): boolean {
  if (spec.op === 'count') return true;
  if (!spec.field) return false;
  if (spec.op === 'pct_matching') return !!spec.value;
  return true;
}

export function GroupedListConfig({ wslug, pslug, tslug, value, onChange }: Props) {
  const { data: fields } = useFields(wslug, pslug, tslug);
  const allFields = fields ?? [];
  // Mirror the kanban group-by exclusion: a multi_select field can't be grouped on.
  const groupableFields = allFields.filter((f) => f.type !== 'multi_select');

  // FIX I-2: the aggregate rows are edited against an INTERNAL draft (the full,
  // possibly-incomplete list) so an in-progress row (avg with no field yet)
  // stays visible while the user finishes it. The EMITTED `onChange` value is
  // pruned to complete specs only, so the consumer's create/save payload never
  // carries a spec the server would 422. The draft seeds from `value.aggregates`
  // once; thereafter local edits drive the UI.
  const [draftAggregates, setDraftAggregates] = useState<AggregateSpec[]>(value.aggregates);

  // Commit a new draft aggregate list: update the visible draft AND emit the
  // pruned settings upward (groupBy/rowLayout taken from the controlled `value`).
  function commitAggregates(nextAggregates: AggregateSpec[]) {
    setDraftAggregates(nextAggregates);
    onChange({ ...value, aggregates: nextAggregates.filter(isCompleteSpec) });
  }

  // Non-aggregate edits emit using the current pruned draft so they never
  // resurrect an incomplete spec into the payload.
  function emitWithDraft(next: Omit<GroupedListSettings, 'aggregates'>) {
    onChange({ ...next, aggregates: draftAggregates.filter(isCompleteSpec) });
  }

  function patchAggregate(index: number, patch: Partial<AggregateSpec>) {
    commitAggregates(draftAggregates.map((a, i) => (i === index ? { ...a, ...patch } : a)));
  }

  function setOp(index: number, op: AggregateSpec['op']) {
    // `count` carries neither field nor value; `pct_matching` keeps both; the
    // rest keep `field` and drop `value`. Normalise on op-change so the assembled
    // spec never carries a stale field/value the new op doesn't use.
    const current = draftAggregates[index];
    const nextSpec: AggregateSpec =
      op === 'count'
        ? { op }
        : op === 'pct_matching'
          ? { op, field: current?.field, value: current?.value ?? '' }
          : { op, field: current?.field };
    commitAggregates(draftAggregates.map((a, i) => (i === index ? nextSpec : a)));
  }

  function addAggregate() {
    commitAggregates([...draftAggregates, { op: 'count' }]);
  }

  function removeAggregate(index: number) {
    commitAggregates(draftAggregates.filter((_, i) => i !== index));
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
          onChange={(e) => emitWithDraft({ ...value, groupBy: e.target.value })}
        >
          <option value="status">Status</option>
          {groupableFields.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label ?? f.key}
            </option>
          ))}
        </select>
      </div>

      {/* Aggregate builder */}
      <div>
        <span className="block text-sm font-medium text-fg">Aggregates</span>
        <div className="mt-2 space-y-2">
          {draftAggregates.map((agg, i) => {
            const n = i + 1;
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: aggregate rows are positional (no stable id) and only reorder via add/remove at the tail.
                key={i}
                className="flex flex-wrap items-end gap-2 rounded-md border border-border-light p-2"
              >
                <div className="min-w-[7rem] flex-1">
                  <label htmlFor={`gl-agg-op-${i}`} className="block text-xs text-fg-3">
                    Aggregation {n}
                  </label>
                  <select
                    id={`gl-agg-op-${i}`}
                    className={selectClass}
                    value={agg.op}
                    onChange={(e) => setOp(i, e.target.value as AggregateSpec['op'])}
                  >
                    {AGGREGATIONS.map((op) => (
                      <option key={op} value={op}>
                        {op}
                      </option>
                    ))}
                  </select>
                </div>

                {/* `count` needs no field; every other op groups on a field. */}
                {agg.op !== 'count' && (
                  <div className="min-w-[7rem] flex-1">
                    <label htmlFor={`gl-agg-field-${i}`} className="block text-xs text-fg-3">
                      Aggregate field {n}
                    </label>
                    <select
                      id={`gl-agg-field-${i}`}
                      className={selectClass}
                      value={agg.field ?? ''}
                      onChange={(e) => patchAggregate(i, { field: e.target.value })}
                    >
                      <option value="">Select a field…</option>
                      {allFields.map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.label ?? f.key}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {/* `pct_matching` needs a value to match against. */}
                {agg.op === 'pct_matching' && (
                  <div className="min-w-[7rem] flex-1">
                    <label htmlFor={`gl-agg-value-${i}`} className="block text-xs text-fg-3">
                      Match value {n}
                    </label>
                    <input
                      id={`gl-agg-value-${i}`}
                      className={inputClass}
                      value={agg.value ?? ''}
                      onChange={(e) => patchAggregate(i, { value: e.target.value })}
                    />
                  </div>
                )}

                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`Remove aggregate ${n}`}
                  onClick={() => removeAggregate(i)}
                >
                  Remove
                </Button>
              </div>
            );
          })}
        </div>
        <Button type="button" variant="secondary" className="mt-2" onClick={addAggregate}>
          Add aggregate
        </Button>
      </div>
    </div>
  );
}
