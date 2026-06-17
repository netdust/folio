import type { AggregateSpec } from '@folio/shared';
import { toast } from 'sonner';
import { useFields } from '../../lib/api/fields.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { useActiveView } from '../../lib/api/use-active-view.ts';
import { useUpdateView } from '../../lib/api/views.ts';
import { AggregateBuilder } from './aggregate-builder.tsx';
import { defaultGroupedListSettings } from './grouped-list-config.tsx';

interface Props {
  wslug: string;
  pslug: string;
  tslug: string;
}

const selectClass =
  'rounded-md border border-border-light bg-shell px-2 py-1 text-sm text-fg input-focus';

/**
 * THE fix for "once a view is created I can't change the settings anymore":
 * inline controls on a grouped `list` view that EDIT THE ACTIVE VIEW's
 * `settings` LIVE (group-by + aggregates), persisting via `useUpdateView` on
 * every change. Mirrors `BoardControls` (the kanban sibling that edits the
 * active view's `groupBy`/`sort`); here we edit the grouped list's
 * `settings.{groupBy, aggregates}`.
 *
 * INVARIANT 16: a list-setting change writes the VIEW (PATCH /views/:id,
 * `patch.settings`) — NEVER a document. Group-by and aggregates are view
 * configuration, not document data.
 */
export function ListControls({ wslug, pslug, tslug }: Props) {
  const { view } = useActiveView(wslug, pslug, tslug);
  const { data: fields } = useFields(wslug, pslug, tslug);
  const updateView = useUpdateView(wslug, pslug, tslug);

  if (!view) return null;

  // Read the CURRENT values from the saved view's settings, defaulting to the
  // same shape a freshly-created list view carries.
  const defaults = defaultGroupedListSettings();
  const settings = (view.settings ?? {}) as Partial<{
    groupBy: string;
    aggregates: AggregateSpec[];
  }>;
  const groupBy = settings.groupBy ?? defaults.groupBy;
  const aggregates = settings.aggregates ?? defaults.aggregates;

  const allFields = fields ?? [];
  // Mirror the kanban/grouped-list group-by exclusion: multi_select can't group.
  const groupableFields = allFields.filter((f) => f.type !== 'multi_select');

  // Persist a settings patch to the active VIEW, merging over the saved settings
  // so we never drop sibling keys (e.g. rowLayout). Error → toast (optimistic).
  function persist(patch: { groupBy?: string; aggregates?: AggregateSpec[] }) {
    if (!view) return;
    updateView.mutate(
      { id: view.id, patch: { settings: { ...view.settings, ...patch } } },
      { onError: (err) => toast.error(formatApiError(err)) },
    );
  }

  return (
    <div className="flex flex-wrap items-start gap-3">
      <div className="flex items-center gap-1">
        <label htmlFor="lc-group-by" className="text-sm text-fg-3">
          Group by
        </label>
        <select
          id="lc-group-by"
          className={selectClass}
          value={groupBy}
          onChange={(e) => persist({ groupBy: e.target.value })}
        >
          <option value="status">Status</option>
          {groupableFields.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label ?? f.key}
            </option>
          ))}
        </select>
      </div>

      <AggregateBuilder
        fields={allFields}
        aggregates={aggregates}
        onChange={(next) => persist({ aggregates: next })}
      />
    </div>
  );
}
