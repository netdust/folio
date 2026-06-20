import { useState } from 'react';
import type { FilterClauseUrl } from '../../lib/api/documents.ts';
import type { Field } from '../../lib/api/fields.ts';
import type { Status } from '../../lib/api/statuses.ts';
import { ChipAdd } from '../ui/chip.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';

interface Props {
  statuses: Status[];
  filterableFields: Field[];
  existing: FilterClauseUrl[];
  onAdd: (clause: FilterClauseUrl) => void;
}

export function FilterAdd({ statuses, filterableFields, existing, onAdd }: Props) {
  const [open, setOpen] = useState(false);
  const [pickedKey, setPickedKey] = useState<string | null>(null);

  const usedKinds = new Set(existing.map((e) => e.kind));

  const close = () => {
    setOpen(false);
    setPickedKey(null);
  };

  const offerStatus = !usedKinds.has('status') && statuses.length > 0;
  const offerPriority =
    !usedKinds.has('priority') && filterableFields.some((f) => f.key === 'priority');
  const offerLabels = !usedKinds.has('labels') && filterableFields.some((f) => f.key === 'labels');
  const offerAssignee = !usedKinds.has('assignee');
  const offerUpdated = !usedKinds.has('updated_since');

  const priorityField = filterableFields.find((f) => f.key === 'priority');
  const labelsField = filterableFields.find((f) => f.key === 'labels');

  // Generic custom-field filters: every pinned field that is NOT already covered
  // by a built-in kind (priority/labels keep their bespoke pickers) and is not
  // already in use. `title`/`status` are columns, not frontmatter fields — they
  // never appear in `filterableFields`. The op is derived from the field type.
  const usedFieldKeys = new Set(
    existing.filter((e) => e.kind === 'field').map((e) => (e as { key: string }).key),
  );
  const BUILT_IN_FIELD_KEYS = new Set(['priority', 'labels']);
  const fieldOptions = filterableFields.filter(
    (f) => !BUILT_IN_FIELD_KEYS.has(f.key) && !usedFieldKeys.has(f.key),
  );
  const opFor = (type: string): '$eq' | '$contains' =>
    type === 'multi_select' ? '$contains' : '$eq';
  const pickedField = pickedKey?.startsWith('field:')
    ? filterableFields.find((f) => f.key === pickedKey.slice('field:'.length))
    : undefined;

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setPickedKey(null);
      }}
    >
      <PopoverTrigger asChild>
        <ChipAdd />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[260px] p-1">
        {pickedKey === null ? (
          <ul className="flex flex-col">
            {offerStatus ? (
              <Pick label="Status" hint="is" onClick={() => setPickedKey('status')} />
            ) : null}
            {offerPriority ? (
              <Pick label="Priority" hint="is" onClick={() => setPickedKey('priority')} />
            ) : null}
            {offerLabels ? (
              <Pick label="Labels" hint="includes" onClick={() => setPickedKey('labels')} />
            ) : null}
            {offerAssignee ? (
              <Pick label="Assignee" hint="is" onClick={() => setPickedKey('assignee')} />
            ) : null}
            {offerUpdated ? (
              <Pick
                label="Updated since"
                hint="date"
                onClick={() => setPickedKey('updated_since')}
              />
            ) : null}
            {fieldOptions.map((f) => (
              <Pick
                key={f.key}
                label={f.label ?? f.key}
                hint={f.type === 'multi_select' ? 'has' : 'is'}
                onClick={() => setPickedKey(`field:${f.key}`)}
              />
            ))}
            {!offerStatus &&
            !offerPriority &&
            !offerLabels &&
            !offerAssignee &&
            !offerUpdated &&
            fieldOptions.length === 0 ? (
              <li className="px-2 py-1.5 text-xs text-fg-3">All filters in use.</li>
            ) : null}
          </ul>
        ) : pickedField ? (
          <FieldValuePicker
            field={pickedField}
            onPick={(value) => {
              onAdd({ kind: 'field', key: pickedField.key, op: opFor(pickedField.type), value });
              close();
            }}
          />
        ) : pickedKey === 'status' ? (
          <ul className="flex flex-col">
            {statuses.map((s) => (
              <Pick
                key={s.key}
                label={s.name}
                color={s.color}
                onClick={() => {
                  onAdd({ kind: 'status', values: [s.key] });
                  close();
                }}
              />
            ))}
          </ul>
        ) : pickedKey === 'priority' && priorityField?.options ? (
          <ul className="flex flex-col">
            {priorityField.options.map((opt) => (
              <Pick
                key={opt}
                label={opt}
                onClick={() => {
                  onAdd({ kind: 'priority', value: opt });
                  close();
                }}
              />
            ))}
          </ul>
        ) : pickedKey === 'labels' && labelsField?.options ? (
          <ul className="flex flex-col">
            {labelsField.options.map((opt) => (
              <Pick
                key={opt}
                label={opt}
                onClick={() => {
                  onAdd({ kind: 'labels', values: [opt] });
                  close();
                }}
              />
            ))}
          </ul>
        ) : pickedKey === 'assignee' ? (
          <FreeInput
            placeholder="user@example.com"
            onSubmit={(v) => {
              onAdd({ kind: 'assignee', value: v });
              close();
            }}
          />
        ) : pickedKey === 'updated_since' ? (
          <FreeInput
            type="date"
            placeholder="YYYY-MM-DD"
            onSubmit={(v) => {
              onAdd({ kind: 'updated_since', value: v });
              close();
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** The value step for a generic field filter — option-list for select-like
 *  fields, true/false for boolean, free text otherwise. */
function FieldValuePicker({ field, onPick }: { field: Field; onPick: (v: string) => void }) {
  if ((field.type === 'select' || field.type === 'multi_select') && field.options?.length) {
    return (
      <ul className="flex flex-col">
        {field.options.map((opt) => (
          <Pick key={opt} label={opt} onClick={() => onPick(opt)} />
        ))}
      </ul>
    );
  }
  if (field.type === 'boolean') {
    return (
      <ul className="flex flex-col">
        <Pick label="true" onClick={() => onPick('true')} />
        <Pick label="false" onClick={() => onPick('false')} />
      </ul>
    );
  }
  return <FreeInput placeholder={`${field.label ?? field.key}…`} onSubmit={onPick} />;
}

function Pick({
  label,
  hint,
  color,
  onClick,
}: {
  label: string;
  hint?: string;
  color?: string;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-card"
      >
        {color ? (
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
        ) : null}
        <span className="flex-1">{label}</span>
        {hint ? <span className="text-xs text-fg-3">{hint}</span> : null}
      </button>
    </li>
  );
}

function FreeInput({
  placeholder,
  type = 'text',
  onSubmit,
}: {
  placeholder: string;
  type?: 'text' | 'date';
  onSubmit: (v: string) => void;
}) {
  const [v, setV] = useState('');
  return (
    <form
      className="p-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) onSubmit(v.trim());
      }}
    >
      <input
        type={type}
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder={placeholder}
        className="block w-full rounded-sm border border-border-light bg-shell px-2 py-1 text-sm text-fg input-focus"
      />
    </form>
  );
}
