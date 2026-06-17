import { useNavigate, useSearch } from '@tanstack/react-router';
import { toast } from 'sonner';
import { type FilterClauseUrl, parseFilters } from '../../lib/api/documents.ts';
import { type Field, useFields } from '../../lib/api/fields.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { useStatuses } from '../../lib/api/statuses.ts';
import { useActiveView } from '../../lib/api/use-active-view.ts';
import { useUpdateView } from '../../lib/api/views.ts';
import { FilterBar } from '../filter/filter-bar.tsx';
import { BoardControls } from '../kanban/board-controls.tsx';
import { ListControls } from './list-controls.tsx';
import { useViewFilterHydration } from './use-view-filter-hydration.ts';
import { settingString } from './view-settings.ts';

interface Props {
  wslug: string;
  pslug: string;
  tslug: string;
}

const selectClass =
  'rounded-md border border-border-light bg-shell px-2 py-1 text-sm text-fg input-focus';

const TIMELINE_ZOOMS = ['day', 'week', 'month'] as const;
const ZOOM_LABELS: Record<(typeof TIMELINE_ZOOMS)[number], string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
};

/** Project date/datetime fields — the candidate columns for calendar/timeline placement. */
function dateFields(fields: Field[]): Field[] {
  return fields.filter((f) => f.type === 'date' || f.type === 'datetime');
}

/**
 * THE unified per-view controls bar — the board's model generalized to EVERY
 * view. Mounted ONCE in the project header (not per-view-component). Two pieces:
 *
 *   1. A SHARED FilterBar (identical look/source on every view type), whose
 *      changes are saved PER-VIEW via `useUpdateView` (the ?view= consent gate +
 *      error toast lifted verbatim from TableView's onClauseChange).
 *   2. A per-type settings slot (`switch(view.type)`): kanban → BoardControls
 *      (group-by/sort), list → ListControls (group-by/aggregates), calendar →
 *      a date-field select, timeline → zoom + start/end field selects, table →
 *      none.
 *
 * INVARIANT 16: a FILTER change and EVERY settings change write the VIEW (PATCH
 * /views/:id — filters / settings / groupBy / sort), NEVER a document.
 *
 * INVARIANT 18: the active-view gate — controls reflect the ACTIVE view, not a
 * URL shape. Hydration-on-switch is shared with TableView via
 * `useViewFilterHydration` so every view loads its saved filter on switch.
 */
export function ViewControls({ wslug, pslug, tslug }: Props) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const { view: activeView } = useActiveView(wslug, pslug, tslug);
  const { data: statuses } = useStatuses(wslug, pslug, tslug);
  const { data: fields } = useFields(wslug, pslug, tslug);
  const updateView = useUpdateView(wslug, pslug, tslug);

  const urlViewId = typeof search.view === 'string' ? search.view : undefined;

  // Load the active view's saved filter on switch — shared with TableView so
  // there is ONE hydration source across the app.
  useViewFilterHydration(activeView, search, navigate, urlViewId);

  // The shared filter clauses parsed from the URL search (post-hydration).
  const clauses = parseFilters(search);

  // LIFTED VERBATIM from TableView.onClauseChange: map clauses → URL search AND
  // → a flat filters object saved back to the active view (gated on ?view=).
  const onFilterChange = (next: FilterClauseUrl[]) => {
    const nextSearch: Record<string, unknown> = { ...search };
    const flatFilters: Record<string, unknown> = {};
    for (const k of ['status', 'priority', 'labels', 'assignee', 'updated_since']) {
      delete nextSearch[k];
    }
    for (const c of next) {
      if (c.kind === 'status') {
        nextSearch.status = c.values;
        flatFilters.status = c.values;
      }
      if (c.kind === 'priority') {
        nextSearch.priority = c.value;
        flatFilters.priority = c.value;
      }
      if (c.kind === 'labels') {
        nextSearch.labels = c.values;
        flatFilters.labels = c.values;
      }
      if (c.kind === 'assignee') {
        nextSearch.assignee = c.value;
        flatFilters.assignee = c.value;
      }
      if (c.kind === 'updated_since') {
        nextSearch.updated_since = c.value;
        flatFilters.updated_since = c.value;
      }
    }
    void navigate({ to: '.', search: nextSearch, replace: false });
    // Only autosave when the user has explicitly opened this view (?view=<id>).
    // Without ?view=, activeView is a fallback — filter changes are ad-hoc.
    if (urlViewId && activeView && activeView.id === urlViewId) {
      updateView.mutate(
        { id: activeView.id, patch: { filters: flatFilters } },
        { onError: (err) => toast.error(formatApiError(err)) },
      );
    }
  };

  if (!activeView) return null;

  const allFields = fields ?? [];

  // INVARIANT 16: calendar/timeline field + zoom are VIEW config — every change
  // PATCHes the view's settings (merged over the saved settings so siblings are
  // preserved), NEVER a document.
  const persistSettings = (patch: Record<string, unknown>) => {
    updateView.mutate(
      { id: activeView.id, patch: { settings: { ...activeView.settings, ...patch } } },
      { onError: (err) => toast.error(formatApiError(err)) },
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-3">
      <FilterBar
        clauses={clauses}
        statuses={statuses ?? []}
        pinnedFields={allFields}
        onChange={onFilterChange}
      />
      {renderSettingsSlot()}
    </div>
  );

  function renderSettingsSlot() {
    switch (activeView?.type) {
      case 'kanban':
        // BoardControls already owns the kanban group-by/sort + view persistence.
        return <BoardControls wslug={wslug} pslug={pslug} tslug={tslug} />;
      case 'list':
        // ListControls already owns the grouped-list group-by + aggregates.
        return <ListControls wslug={wslug} pslug={pslug} tslug={tslug} />;
      case 'calendar':
        return <CalendarSettings />;
      case 'timeline':
        return <TimelineSettings />;
      default:
        // table (and any future flat type): filter only.
        return null;
    }
  }

  function CalendarSettings() {
    if (!activeView) return null;
    const dateField = settingString(activeView.settings?.dateField, 'due_date');
    const options = dateFields(allFields);
    return (
      <div className="flex items-center gap-1">
        <label htmlFor="vc-date-field" className="text-sm text-fg-3">
          Date field
        </label>
        <select
          id="vc-date-field"
          className={selectClass}
          value={dateField}
          onChange={(e) => persistSettings({ dateField: e.target.value })}
        >
          <option value="due_date">Due date</option>
          {options.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label ?? f.key}
            </option>
          ))}
        </select>
      </div>
    );
  }

  function TimelineSettings() {
    if (!activeView) return null;
    const zoom = settingString(activeView.settings?.zoom, 'week');
    const startField = settingString(activeView.settings?.startField, 'due_date');
    const endField = settingString(activeView.settings?.endField, 'due_date');
    const options = dateFields(allFields);
    return (
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center rounded-md border border-border-light">
          {TIMELINE_ZOOMS.map((z) => (
            <button
              key={z}
              type="button"
              onClick={() => persistSettings({ zoom: z })}
              aria-pressed={z === zoom}
              className={
                z === zoom
                  ? 'bg-card px-2 py-1 text-sm text-fg first:rounded-l-md last:rounded-r-md'
                  : 'px-2 py-1 text-sm text-fg-2 hover:bg-card first:rounded-l-md last:rounded-r-md'
              }
            >
              {ZOOM_LABELS[z]}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <label htmlFor="vc-start-field" className="text-sm text-fg-3">
            Start field
          </label>
          <select
            id="vc-start-field"
            className={selectClass}
            value={startField}
            onChange={(e) => persistSettings({ startField: e.target.value })}
          >
            <option value="due_date">Due date</option>
            {options.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label ?? f.key}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1">
          <label htmlFor="vc-end-field" className="text-sm text-fg-3">
            End field
          </label>
          <select
            id="vc-end-field"
            className={selectClass}
            value={endField}
            onChange={(e) => persistSettings({ endField: e.target.value })}
          >
            <option value="due_date">Due date</option>
            {options.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label ?? f.key}
              </option>
            ))}
          </select>
        </div>
      </div>
    );
  }
}
