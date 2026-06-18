import type { AggregateSpec } from '@folio/shared';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { Field } from '../../lib/api/fields.ts';
import { useFields } from '../../lib/api/fields.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { useActiveView } from '../../lib/api/use-active-view.ts';
import { useUpdateView } from '../../lib/api/views.ts';
import { Icon } from '../ui/icon.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { AggregateBuilder } from './aggregate-builder.tsx';
import { defaultGroupedListSettings } from './grouped-list-config.tsx';

interface Props {
  wslug: string;
  pslug: string;
  tslug: string;
}

// Mirror BoardToolbar's compact Popover-pill controls so the list view's
// settings look IDENTICAL to the board's (Stefan: the settings fields must look
// the same as the board's). These two classes are the board's module-private
// `triggerClass`/`itemClass` — duplicated verbatim for the same look (a 2-line
// dup is the lightest way to share a style across two restyled toolbars).
const triggerClass =
  'inline-flex items-center gap-1 rounded-sm px-2 py-1 text-xs text-fg-2 hover:bg-card';
const itemClass =
  'flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-sm text-fg-1 hover:bg-card';

function fieldLabel(f: Field): string {
  return f.label ?? f.key;
}

function groupLabel(groupBy: string, fields: Field[]): string {
  if (groupBy === 'status') return 'Status';
  const field = fields.find((f) => f.key === groupBy);
  return field ? fieldLabel(field) : groupBy;
}

/**
 * THE fix for "once a view is created I can't change the settings anymore":
 * inline controls on a grouped `list` view that EDIT THE ACTIVE VIEW's
 * `settings` LIVE (group-by + aggregates), persisting via `useUpdateView` on
 * every change. Mirrors `BoardToolbar` (the kanban sibling that edits the
 * active view's `groupBy`/`sort`) BOTH in behavior AND in look: compact
 * Popover-pills, not bordered cards or native selects.
 *
 * INVARIANT 16: a list-setting change writes the VIEW (PATCH /views/:id,
 * `patch.settings`) — NEVER a document. Group-by and aggregates are view
 * configuration, not document data.
 */
export function ListControls({ wslug, pslug, tslug }: Props) {
  const { view } = useActiveView(wslug, pslug, tslug);
  const { data: fields } = useFields(wslug, pslug, tslug);
  const updateView = useUpdateView(wslug, pslug, tslug);
  const [groupOpen, setGroupOpen] = useState(false);
  const [aggOpen, setAggOpen] = useState(false);

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

  const pickGroupBy = (key: string) => {
    setGroupOpen(false);
    persist({ groupBy: key });
  };

  return (
    <div className="flex flex-shrink-0 items-center gap-2">
      <Popover open={groupOpen} onOpenChange={setGroupOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={triggerClass}>
            <span className="text-fg-3">Group:</span>
            <span>{groupLabel(groupBy, allFields)}</span>
            <Icon icon={ChevronDown} size={14} />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[200px] p-1">
          <button
            type="button"
            role="menuitem"
            className={itemClass}
            onClick={() => pickGroupBy('status')}
          >
            Status
          </button>
          {groupableFields.map((f) => (
            <button
              key={f.key}
              type="button"
              role="menuitem"
              className={itemClass}
              onClick={() => pickGroupBy(f.key)}
            >
              {fieldLabel(f)}
            </button>
          ))}
        </PopoverContent>
      </Popover>

      <Popover open={aggOpen} onOpenChange={setAggOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={triggerClass}>
            <span className="text-fg-3">Aggregates:</span>
            <span>{aggregates.length}</span>
            <Icon icon={ChevronDown} size={14} />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[320px] p-2">
          <AggregateBuilder
            fields={allFields}
            aggregates={aggregates}
            onChange={(next) => persist({ aggregates: next })}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
