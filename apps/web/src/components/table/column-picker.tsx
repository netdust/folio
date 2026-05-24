import { useState } from 'react';
import { Settings2 } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { IconButton } from '../ui/icon-button.tsx';
import { Icon } from '../ui/icon.tsx';
import type { Column } from './columns.ts';

interface Props {
  columns: Column[];
  visibleKeys: string[];
  onChange: (nextVisible: string[]) => void;
}

export function ColumnPicker({ columns, visibleKeys, onChange }: Props) {
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
      <PopoverContent align="end" className="w-[220px] p-1">
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
      </PopoverContent>
    </Popover>
  );
}
