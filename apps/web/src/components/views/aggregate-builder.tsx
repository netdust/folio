import { AGGREGATIONS, type AggregateSpec } from '@folio/shared';
import { useState } from 'react';
import type { Field } from '../../lib/api/fields.ts';
import { Button } from '../ui/button.tsx';

const selectClass =
  'mt-1 block w-full rounded-md border border-border-light bg-shell px-3 py-2 text-fg input-focus';
const inputClass = selectClass;

/**
 * FIX I-2: a non-`count` op leaves `field` empty (and `pct_matching` leaves
 * `value` empty) until the user picks one. Those incomplete specs make the
 * server's group-summary endpoint 422. Callers must prune the EMITTED settings
 * so a view is never created/saved with a broken aggregate. The incomplete row
 * still renders in the UI so the user can finish it — only the emitted value is
 * pruned (via this predicate).
 *
 * Exported so BOTH mounts of the builder (the new-view config and the
 * edit-active-view controls) share ONE definition of "complete" — never
 * duplicate the whitelist/pruning logic.
 */
export function isCompleteAggregate(spec: AggregateSpec): boolean {
  if (spec.op === 'count') return true;
  if (!spec.field) return false;
  if (spec.op === 'pct_matching') return !!spec.value;
  return true;
}

interface Props {
  /** Project fields, fed by the caller's `useFields` (so the builder is mount-agnostic). */
  fields: Field[];
  /** The CURRENT aggregate specs (controlled — the saved/created value). */
  aggregates: AggregateSpec[];
  /**
   * Emits the PRUNED (complete-only) spec list whenever the user edits a row.
   * The incomplete in-progress row stays visible (driven by the internal draft);
   * only the emitted value is pruned, so a consumer never persists a 422-spec.
   */
  onChange: (next: AggregateSpec[]) => void;
}

/**
 * The aggregate-builder UI shared by the new-view `list` config and the
 * edit-active-view ListControls. The aggregation `<select>` maps over the shared
 * `AGGREGATIONS` whitelist — a SIBLING-SITE of the server's `AGGREGATIONS` set
 * (the engine rejects any op outside it). Never hardcode a divergent list here.
 *
 * FIX I-2: rows are edited against an INTERNAL draft (the full, possibly-
 * incomplete list) so an in-progress row (avg with no field yet) stays visible
 * while the user finishes it. The EMITTED `onChange` value is pruned to complete
 * specs only. The draft seeds from `aggregates` once; thereafter local edits
 * drive the UI.
 */
export function AggregateBuilder({ fields, aggregates, onChange }: Props) {
  const [draft, setDraft] = useState<AggregateSpec[]>(aggregates);

  function commit(next: AggregateSpec[]) {
    setDraft(next);
    onChange(next.filter(isCompleteAggregate));
  }

  function patchAggregate(index: number, patch: Partial<AggregateSpec>) {
    commit(draft.map((a, i) => (i === index ? { ...a, ...patch } : a)));
  }

  function setOp(index: number, op: AggregateSpec['op']) {
    // `count` carries neither field nor value; `pct_matching` keeps both; the
    // rest keep `field` and drop `value`. Normalise on op-change so the assembled
    // spec never carries a stale field/value the new op doesn't use.
    const current = draft[index];
    const nextSpec: AggregateSpec =
      op === 'count'
        ? { op }
        : op === 'pct_matching'
          ? { op, field: current?.field, value: current?.value ?? '' }
          : { op, field: current?.field };
    commit(draft.map((a, i) => (i === index ? nextSpec : a)));
  }

  function addAggregate() {
    commit([...draft, { op: 'count' }]);
  }

  function removeAggregate(index: number) {
    commit(draft.filter((_, i) => i !== index));
  }

  return (
    <div>
      <span className="block text-sm font-medium text-fg">Aggregates</span>
      <div className="mt-2 space-y-2">
        {draft.map((agg, i) => {
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
                    {fields.map((f) => (
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
  );
}
