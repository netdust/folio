import { useState } from 'react';
import type { FieldType } from '../../lib/api/fields.ts';
import { InlineEdit } from '../inline/inline-edit.tsx';
import { InlineSelect } from '../inline/inline-select.tsx';
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
        'block w-full rounded-sm border border-border-light bg-shell px-2 py-1.5 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
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
        'block w-32 rounded-sm border border-border-light bg-shell px-2 py-1 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
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
  const [draft, setDraft] = useState(value);
  return (
    <input
      type="date"
      aria-label={ariaLabel}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value && draft) onCommit(draft);
      }}
      className={cn(
        'block w-44 rounded-sm border border-border-light bg-shell px-2 py-1 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
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
        <select
          aria-label={`Add ${ariaLabel}`}
          value=""
          onChange={(e) => {
            if (e.target.value) onCommit([...current, e.target.value]);
          }}
          className="rounded-sm border border-border-light bg-shell px-1 py-0.5 text-xs text-fg-3"
        >
          <option value="" disabled>
            + add…
          </option>
          {remaining.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : null}
    </div>
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
        'block w-full rounded-sm border border-border-light bg-shell px-2 py-1 text-sm text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        isPending && 'opacity-60',
      )}
    />
  );
}
