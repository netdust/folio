import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { FieldType } from '../../lib/api/fields.ts';
import { InlineEdit } from '../inline/inline-edit.tsx';
import { InlineSelect } from '../inline/inline-select.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import { Icon } from '../ui/icon.tsx';
import { cn } from '../ui/cn.ts';

interface Props {
  fieldKey: string;
  type: FieldType;
  value: unknown;
  options?: string[];
  onCommit: (next: unknown) => void;
  isPending?: boolean;
}

export function FieldRenderer({ fieldKey, type, value, options, onCommit, isPending }: Props) {
  switch (type) {
    case 'string':
    case 'datetime': // fallback: plain text in v1
    case 'user_ref':
    case 'document_ref':
      return (
        <InlineEdit
          value={String(value ?? '')}
          onCommit={onCommit}
          isPending={isPending}
          ariaLabel={fieldKey}
        />
      );
    case 'text':
      return (
        <TextArea
          value={String(value ?? '')}
          onCommit={onCommit}
          ariaLabel={fieldKey}
          isPending={isPending}
        />
      );
    case 'number':
      return (
        <NumberInput
          value={typeof value === 'number' ? value : Number(value) || 0}
          onCommit={onCommit}
          ariaLabel={fieldKey}
          isPending={isPending}
        />
      );
    case 'boolean':
      return (
        <input
          type="checkbox"
          aria-label={fieldKey}
          checked={!!value}
          onChange={(e) => onCommit(e.target.checked)}
          className={cn('h-4 w-4 rounded border-border-light', isPending && 'opacity-60')}
        />
      );
    case 'date':
      return (
        <DateInput
          value={typeof value === 'string' ? value : ''}
          onCommit={onCommit}
          ariaLabel={fieldKey}
          isPending={isPending}
        />
      );
    case 'select': {
      const opts = (options ?? []).map((o) => ({ value: o, label: o }));
      return (
        <InlineSelect
          value={typeof value === 'string' ? value : null}
          options={opts}
          onCommit={onCommit}
          isPending={isPending}
        />
      );
    }
    case 'multi_select': {
      const current = Array.isArray(value) ? (value as string[]) : [];
      const opts = options ?? [];
      return (
        <MultiSelect
          current={current}
          options={opts}
          onCommit={onCommit}
          isPending={isPending}
          ariaLabel={fieldKey}
        />
      );
    }
    case 'url': {
      const url = String(value ?? '');
      return (
        <UrlField value={url} onCommit={onCommit} isPending={isPending} ariaLabel={fieldKey} />
      );
    }
    case 'currency': {
      const code = (options?.[0] ?? 'EUR') as string;
      return (
        <CurrencyInput
          value={typeof value === 'number' ? value : null}
          currency={code}
          onCommit={onCommit as (v: number) => void}
          ariaLabel={fieldKey}
          isPending={isPending}
        />
      );
    }
    default:
      return <span className="text-fg-3 italic">unsupported type: {type}</span>;
  }
}

function TextArea({
  value,
  onCommit,
  ariaLabel,
  isPending,
}: {
  value: string;
  onCommit: (v: string) => void;
  ariaLabel: string;
  isPending?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <textarea
      aria-label={ariaLabel}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      rows={3}
      className={cn(
        'block w-full rounded-sm border border-border-light bg-shell px-2 py-1.5 text-sm text-fg input-focus',
        isPending && 'opacity-60',
      )}
    />
  );
}

function NumberInput({
  value,
  onCommit,
  ariaLabel,
  isPending,
}: {
  value: number;
  onCommit: (v: number) => void;
  ariaLabel: string;
  isPending?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  return (
    <input
      type="number"
      aria-label={ariaLabel}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const n = Number(draft);
        if (Number.isFinite(n) && n !== value) onCommit(n);
      }}
      className={cn(
        'block w-32 rounded-sm border border-border-light bg-shell px-2 py-1 text-sm text-fg input-focus',
        isPending && 'opacity-60',
      )}
    />
  );
}

function DateInput({
  value,
  onCommit,
  ariaLabel,
  isPending,
}: {
  value: string;
  onCommit: (v: string) => void;
  ariaLabel: string;
  isPending?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (!editing) {
    return (
      <span
        role="button"
        tabIndex={0}
        aria-label={ariaLabel}
        onClick={() => setEditing(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') setEditing(true);
        }}
        className={cn(
          'inline-block cursor-text rounded-sm px-1 py-0.5 text-sm hover:bg-card',
          isPending && 'opacity-60',
        )}
      >
        {value || <span className="text-fg-3"> </span>}
      </span>
    );
  }
  return (
    <input
      type="date"
      aria-label={ariaLabel}
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (draft !== value && draft) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setDraft(value);
          setEditing(false);
        }
      }}
      className={cn(
        'block w-44 rounded-sm border border-transparent bg-card px-1 py-0.5 text-sm text-fg input-focus',
        isPending && 'opacity-60',
      )}
    />
  );
}

function MultiSelect({
  current,
  options,
  onCommit,
  isPending,
  ariaLabel,
}: {
  current: string[];
  options: string[];
  onCommit: (v: string[]) => void;
  isPending?: boolean;
  ariaLabel: string;
}) {
  const remaining = options.filter((o) => !current.includes(o));
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn('flex flex-wrap items-center gap-1', isPending && 'opacity-60')}
    >
      {current.map((c) => (
        <span
          key={c}
          className="inline-flex items-center gap-1 rounded-sm bg-card px-1.5 py-0.5 text-xs text-fg"
        >
          {c}
          <button
            type="button"
            aria-label={`Remove ${c}`}
            onClick={() => onCommit(current.filter((x) => x !== c))}
            className="text-fg-3 hover:text-fg"
          >
            ×
          </button>
        </span>
      ))}
      {remaining.length > 0 ? (
        <MultiSelectAdd
          remaining={remaining}
          ariaLabel={ariaLabel}
          onAdd={(v) => onCommit([...current, v])}
        />
      ) : null}
    </div>
  );
}

function MultiSelectAdd({
  remaining,
  ariaLabel,
  onAdd,
}: {
  remaining: string[];
  ariaLabel: string;
  onAdd: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Add ${ariaLabel}`}
          className="inline-grid h-5 w-5 place-items-center rounded-sm text-fg-3 hover:bg-card hover:text-fg-2"
        >
          <Icon icon={Plus} size={14} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[180px] p-1">
        <ul className="flex flex-col">
          {remaining.map((opt) => (
            <li key={opt}>
              <button
                type="button"
                onClick={() => {
                  onAdd(opt);
                  setOpen(false);
                }}
                className="block w-full rounded-sm px-2 py-1 text-left text-sm hover:bg-card"
              >
                {opt}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function UrlField({
  value,
  onCommit,
  isPending,
  ariaLabel,
}: {
  value: string;
  onCommit: (v: string) => void;
  isPending?: boolean;
  ariaLabel: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (!editing) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey) return;
          e.preventDefault();
          setEditing(true);
        }}
        className={cn(
          'truncate text-sm text-primary underline-offset-2 hover:underline',
          isPending && 'opacity-60',
        )}
      >
        {value || '(empty)'}
      </a>
    );
  }
  return (
    <input
      type="url"
      aria-label={ariaLabel}
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setDraft(value);
          setEditing(false);
        }
      }}
      className={cn(
        'block w-full rounded-sm border border-border-light bg-shell px-2 py-1 text-sm text-fg input-focus',
        isPending && 'opacity-60',
      )}
    />
  );
}

const formatterCache = new Map<string, Intl.NumberFormat>();
function getCurrencyFormatter(currency: string): Intl.NumberFormat {
  const cached = formatterCache.get(currency);
  if (cached) return cached;
  const f = new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 });
  formatterCache.set(currency, f);
  return f;
}

function CurrencyInput({
  value,
  currency,
  onCommit,
  ariaLabel,
  isPending,
}: {
  value: number | null;
  currency: string;
  onCommit: (v: number) => void;
  ariaLabel: string;
  isPending?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value == null ? '' : String(value));
  const formatter = getCurrencyFormatter(currency);
  if (!editing) {
    return (
      <span
        role="button"
        tabIndex={0}
        onClick={() => setEditing(true)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setEditing(true); }}
        className={cn(
          'inline-block w-full cursor-text rounded-sm px-1 py-0.5 text-right text-sm font-mono hover:bg-card',
          isPending && 'opacity-60',
        )}
      >
        {value == null ? ' ' : formatter.format(value)}
      </span>
    );
  }
  return (
    <input
      type="number"
      aria-label={ariaLabel}
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        const n = Number(draft);
        if (Number.isFinite(n) && n !== value) onCommit(n);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') { setDraft(value == null ? '' : String(value)); setEditing(false); }
      }}
      className={cn(
        'block w-32 rounded-sm border border-border-light bg-shell px-2 py-1 text-right text-sm font-mono text-fg input-focus',
        isPending && 'opacity-60',
      )}
    />
  );
}
