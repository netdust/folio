import { AGGREGATIONS, type AggregateSpec, type GroupedListSettings } from '@folio/shared';
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
 * affordance). Driven by `useFields`: a group-by picker, an aggregate builder,
 * and a row-layout picker, assembled into a `GroupedListSettings`.
 *
 * The aggregation `<select>` maps over the shared `AGGREGATIONS` whitelist — a
 * SIBLING-SITE of the server's `AGGREGATIONS` set (the engine rejects any op
 * outside it). Never hardcode a divergent list here.
 */
export function GroupedListConfig({ wslug, pslug, tslug, value, onChange }: Props) {
  const { data: fields } = useFields(wslug, pslug, tslug);
  const allFields = fields ?? [];
  // Mirror the kanban group-by exclusion: a multi_select field can't be grouped on.
  const groupableFields = allFields.filter((f) => f.type !== 'multi_select');

  function patchAggregate(index: number, patch: Partial<AggregateSpec>) {
    const next = value.aggregates.map((a, i) => (i === index ? { ...a, ...patch } : a));
    onChange({ ...value, aggregates: next });
  }

  function setOp(index: number, op: AggregateSpec['op']) {
    // `count` carries neither field nor value; `pct_matching` keeps both; the
    // rest keep `field` and drop `value`. Normalise on op-change so the assembled
    // spec never carries a stale field/value the new op doesn't use.
    const current = value.aggregates[index];
    const nextSpec: AggregateSpec =
      op === 'count'
        ? { op }
        : op === 'pct_matching'
          ? { op, field: current?.field, value: current?.value ?? '' }
          : { op, field: current?.field };
    const next = value.aggregates.map((a, i) => (i === index ? nextSpec : a));
    onChange({ ...value, aggregates: next });
  }

  function addAggregate() {
    onChange({ ...value, aggregates: [...value.aggregates, { op: 'count' }] });
  }

  function removeAggregate(index: number) {
    onChange({ ...value, aggregates: value.aggregates.filter((_, i) => i !== index) });
  }

  function toggleBodyField(key: string, checked: boolean) {
    const fieldsList = checked
      ? [...value.rowLayout.fields, key]
      : value.rowLayout.fields.filter((k) => k !== key);
    onChange({ ...value, rowLayout: { ...value.rowLayout, fields: fieldsList } });
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
          onChange={(e) => onChange({ ...value, groupBy: e.target.value })}
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
          {value.aggregates.map((agg, i) => {
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

      {/* Row-layout picker */}
      <fieldset>
        <legend className="block text-sm font-medium text-fg">Row layout</legend>
        <div className="mt-2 space-y-3">
          <div>
            <label htmlFor="gl-primary" className="block text-xs text-fg-3">
              Primary
            </label>
            <select
              id="gl-primary"
              className={selectClass}
              value={value.rowLayout.primary}
              onChange={(e) =>
                onChange({ ...value, rowLayout: { ...value.rowLayout, primary: e.target.value } })
              }
            >
              <option value="title">Title</option>
              {allFields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label ?? f.key}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="gl-subtitle" className="block text-xs text-fg-3">
              Subtitle
            </label>
            <select
              id="gl-subtitle"
              className={selectClass}
              value={value.rowLayout.subtitle ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                const { subtitle: _drop, ...rest } = value.rowLayout;
                onChange({
                  ...value,
                  rowLayout: v ? { ...rest, subtitle: v } : rest,
                });
              }}
            >
              <option value="">None</option>
              {allFields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label ?? f.key}
                </option>
              ))}
            </select>
          </div>

          <div>
            <span className="block text-xs text-fg-3">Body fields</span>
            <div className="mt-1.5 space-y-1.5">
              {allFields.map((f) => {
                const label = f.label ?? f.key;
                return (
                  <label key={f.key} className="flex items-center gap-2 text-sm text-fg-1">
                    <input
                      type="checkbox"
                      aria-label={label}
                      checked={value.rowLayout.fields.includes(f.key)}
                      onChange={(e) => toggleBodyField(f.key, e.target.checked)}
                    />
                    {label}
                  </label>
                );
              })}
            </div>
          </div>
        </div>
      </fieldset>
    </div>
  );
}
