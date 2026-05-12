import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { ChipAdd } from '../ui/chip.tsx';
import type { Status } from '../../lib/api/statuses.ts';
import type { Field } from '../../lib/api/fields.ts';
import type { FilterClauseUrl } from '../../lib/api/documents.ts';

interface Props {
  statuses: Status[];
  pinnedFields: Field[];
  existing: FilterClauseUrl[];
  onAdd: (clause: FilterClauseUrl) => void;
}

export function FilterAdd({ statuses, pinnedFields, existing, onAdd }: Props) {
  const [open, setOpen] = useState(false);
  const [pickedKey, setPickedKey] = useState<string | null>(null);

  const usedKinds = new Set(existing.map((e) => e.kind));

  const close = () => {
    setOpen(false);
    setPickedKey(null);
  };

  const offerStatus = !usedKinds.has('status') && statuses.length > 0;
  const offerPriority = !usedKinds.has('priority') && pinnedFields.some((f) => f.key === 'priority');
  const offerLabels = !usedKinds.has('labels') && pinnedFields.some((f) => f.key === 'labels');
  const offerAssignee = !usedKinds.has('assignee');
  const offerUpdated = !usedKinds.has('updated_since');

  const priorityField = pinnedFields.find((f) => f.key === 'priority');
  const labelsField = pinnedFields.find((f) => f.key === 'labels');

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
              <Pick label="Updated since" hint="date" onClick={() => setPickedKey('updated_since')} />
            ) : null}
            {!offerStatus && !offerPriority && !offerLabels && !offerAssignee && !offerUpdated ? (
              <li className="px-2 py-1.5 text-xs text-fg-3">All filters in use.</li>
            ) : null}
          </ul>
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
        className="block w-full rounded-sm border border-border-light bg-shell px-2 py-1 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        autoFocus
      />
    </form>
  );
}
