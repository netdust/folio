import { useState } from 'react';
import { Settings2, Plus } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { IconButton } from '../ui/icon-button.tsx';
import { Icon } from '../ui/icon.tsx';
import type { Column } from './columns.ts';
import type { ColumnSuggestion } from './column-suggestions.ts';
import type { FieldType } from '../../lib/api/fields.ts';

interface Props {
  columns: Column[];
  visibleKeys: string[];
  onChange: (nextVisible: string[]) => void;
  suggestions?: ColumnSuggestion[];
  onPinSuggestion?: (payload: { key: string; type: FieldType; label: string }) => Promise<void> | void;
}

// Tiny local duplicate of `titleize` to avoid a shared util for one other
// caller (table-add-column.tsx). Promote to a shared helper only when a third
// call site appears.
function titleize(key: string): string {
  return key
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function ColumnPicker({
  columns,
  visibleKeys,
  onChange,
  suggestions,
  onPinSuggestion,
}: Props) {
  const [open, setOpen] = useState(false);
  const isVisible = (k: string) => visibleKeys.includes(k);
  const toggle = (k: string) => {
    if (isVisible(k)) onChange(visibleKeys.filter((x) => x !== k));
    else onChange([...visibleKeys, k]);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton label="Columns" size="sm">
          <Icon icon={Settings2} size={14} />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[260px] p-1">
        <div className="px-2 py-1 text-[11px] uppercase tracking-wide text-fg-3">Columns</div>
        <ul className="flex flex-col">
          {columns.map((c) => (
            <li key={c.key}>
              <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-sm hover:bg-card">
                <input
                  type="checkbox"
                  checked={isVisible(c.key)}
                  onChange={() => toggle(c.key)}
                  aria-label={`Toggle ${c.label}`}
                />
                <span className="flex-1">{c.label}</span>
                {c.source === 'builtin' ? (
                  <span className="text-[10px] text-fg-3">built-in</span>
                ) : null}
              </label>
            </li>
          ))}
        </ul>

        {suggestions && suggestions.length > 0 ? (
          <>
            <div className="mt-2 border-t border-border-light px-2 pt-2 text-[11px] uppercase tracking-wide text-fg-3">
              Suggested from your data
            </div>
            <ul className="flex flex-col">
              {suggestions.map((s) => (
                <li
                  key={s.key}
                  className="flex items-center gap-2 rounded-sm px-2 py-1 text-sm hover:bg-card"
                >
                  <span className="flex-1 font-mono text-xs">{s.key}</span>
                  <span className="text-[10px] text-fg-3">{s.inferredType}</span>
                  <IconButton
                    label={`Pin ${s.key}`}
                    size="sm"
                    onClick={() =>
                      onPinSuggestion?.({
                        key: s.key,
                        type: s.inferredType,
                        label: titleize(s.key),
                      })
                    }
                  >
                    <Icon icon={Plus} size={14} />
                  </IconButton>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
