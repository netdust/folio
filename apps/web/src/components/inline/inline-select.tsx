import { useState, type ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { cn } from '../ui/cn.ts';

export interface SelectOption {
  value: string;
  label: string;
  color?: string;
  hint?: ReactNode;
}

interface Props {
  value: string | null;
  options: SelectOption[];
  onCommit: (next: string) => void;
  isPending?: boolean;
  placeholder?: string;
  renderDisplay?: (option: SelectOption | null) => ReactNode;
  className?: string;
}

export function InlineSelect({
  value,
  options,
  onCommit,
  isPending = false,
  placeholder,
  renderDisplay,
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value) ?? null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex cursor-pointer items-center rounded-sm px-1.5 py-0.5 text-xs hover:bg-card focus:outline-none focus-visible:[box-shadow:var(--ring)]',
            isPending && 'opacity-60',
            className,
          )}
        >
          {renderDisplay ? (
            renderDisplay(current)
          ) : current ? (
            <span style={current.color ? { color: current.color } : undefined}>{current.label}</span>
          ) : (
            <span className="text-fg-3">{placeholder ?? 'select…'}</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="min-w-[180px] p-1">
        <ul role="listbox" className="flex flex-col">
          {options.map((opt) => (
            <li key={opt.value} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={opt.value === value}
                onClick={() => {
                  setOpen(false);
                  if (opt.value !== value) onCommit(opt.value);
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-sm hover:bg-card',
                  opt.value === value && 'bg-card',
                )}
              >
                {opt.color ? (
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: opt.color }} />
                ) : null}
                <span className="flex-1">{opt.label}</span>
                {opt.hint ? <span className="text-xs text-fg-3">{opt.hint}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
