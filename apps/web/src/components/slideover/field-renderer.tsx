import { Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FieldType } from '../../lib/api/fields.ts';
import { DisplayBox, EditableShell, NO_SPINNER, SHELL_INPUT } from '../inline/editable-shell.tsx';
import { InlineEdit } from '../inline/inline-edit.tsx';
import { InlineSelect } from '../inline/inline-select.tsx';
import { RelationCell } from '../relations/relation-cell.tsx';
import { type RelationCandidate, RelationPicker } from '../relations/relation-picker.tsx';
import { cn } from '../ui/cn.ts';
import { Icon } from '../ui/icon.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';

const RELATION_TOKEN_RE = /^\[\[([\w-]+)\]\]$/;

interface Props {
  fieldKey: string;
  type: FieldType;
  value: unknown;
  options?: string[];
  onCommit: (next: unknown) => void;
  isPending?: boolean;
  // Slideover-only: when provided, the relation case renders an editable
  // chips+picker surface. Omitted on the table path, where the relation case
  // falls back to read-only chips (RelationCell).
  relationCandidates?: RelationCandidate[];
  resolveSlug?: (slug: string) => { slug: string; title: string } | null;
}

export function FieldRenderer({
  fieldKey,
  type,
  value,
  options,
  onCommit,
  isPending,
  relationCandidates,
  resolveSlug,
}: Props) {
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
    case 'image': {
      const url = String(value ?? '');
      return (
        <ImageField value={url} onCommit={onCommit} isPending={isPending} ariaLabel={fieldKey} />
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
    case 'relation': {
      const resolve = resolveSlug ?? (() => null);
      // Table path: no candidates threaded → read-only chips.
      if (relationCandidates === undefined) {
        return <RelationCell value={value} resolve={resolve} />;
      }
      // Slideover path: editable chips + scoped picker.
      const isMulti = options?.[1] === 'multi';
      return (
        <RelationField
          value={value}
          isMulti={isMulti}
          candidates={relationCandidates}
          resolve={resolve}
          onCommit={onCommit}
          isPending={isPending}
          ariaLabel={fieldKey}
        />
      );
    }
    default:
      return <span className="text-fg-3 italic">unsupported type: {type}</span>;
  }
}

function toRelationTokens(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

function tokenSlug(token: string): string | null {
  return RELATION_TOKEN_RE.exec(token)?.[1] ?? null;
}

function RelationField({
  value,
  isMulti,
  candidates,
  resolve,
  onCommit,
  isPending,
  ariaLabel,
}: {
  value: unknown;
  isMulti: boolean;
  candidates: RelationCandidate[];
  resolve: (slug: string) => { slug: string; title: string } | null;
  onCommit: (next: unknown) => void;
  isPending?: boolean;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const tokens = toRelationTokens(value);
  const alreadyLinkedSlugs = tokens.map(tokenSlug).filter((s): s is string => s !== null);

  const addLink = (slug: string) => {
    const token = `[[${slug}]]`;
    if (isMulti) {
      if (tokens.includes(token)) return;
      onCommit([...tokens, token]);
    } else {
      onCommit(token);
    }
    setQuery('');
    setOpen(false);
  };

  const removeLink = (token: string) => {
    if (isMulti) {
      onCommit(tokens.filter((t) => t !== token));
    } else {
      onCommit('');
    }
  };

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn('flex flex-wrap items-center gap-1', isPending && 'opacity-60')}
    >
      {tokens.map((tok) => {
        const slug = tokenSlug(tok);
        const resolved = slug ? resolve(slug) : null;
        return (
          <span
            key={tok}
            className={cn(
              'inline-flex items-center gap-1 rounded-sm bg-card px-1.5 py-0.5 text-sm',
              resolved ? 'text-fg' : 'font-mono text-fg-3 line-through',
            )}
          >
            {resolved ? resolved.title : tok}
            <button
              type="button"
              aria-label={`Remove ${resolved ? resolved.title : tok}`}
              onClick={() => removeLink(tok)}
              className="text-fg-3 hover:text-fg"
            >
              ×
            </button>
          </span>
        );
      })}
      {isMulti || tokens.length === 0 ? (
        <Popover
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            if (!o) setQuery('');
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`Add link to ${ariaLabel}`}
              className="inline-grid h-5 w-5 place-items-center rounded-sm text-fg-3 hover:bg-card hover:text-fg-2"
            >
              <Icon icon={Plus} size={14} />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-auto border-none bg-transparent p-0 shadow-none"
          >
            <input
              placeholder="Search documents…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="mb-1 block w-[260px] rounded-sm border border-border-light bg-shell px-2 py-1 text-sm input-focus"
            />
            <RelationPicker
              candidates={candidates}
              query={query}
              excludeSlugs={alreadyLinkedSlugs}
              onSelect={(target) => addLink(target.slug)}
              onClose={() => setOpen(false)}
            />
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
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
  // TextArea is MULTI-LINE: the EditableShell is an inline `<span>` that owns a
  // single-line box metric (`py-0.5` + the display↔edit box-equivalence is a
  // single-line guarantee), which does NOT fit a 3-row textarea. Per the plan's
  // explicit carve-out, the textarea keeps its OWN box (its own rounded/border/
  // bg/padding + `rows` height) but ADOPTS the shell's FONT token (`text-sm`) so
  // it stays font-consistent with the shell-rendered single-line fields. We wrap
  // it in `EditableShell mode="edit"` for that font + focus/pending treatment;
  // the textarea drops its own duplicated radius/border/bg/text-size so the shell
  // is the single source of those, keeping only its multi-line padding + height.
  return (
    <EditableShell mode="edit" isPending={isPending} className="block w-full p-0">
      <textarea
        aria-label={ariaLabel}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== value) onCommit(draft);
        }}
        rows={3}
        className="block w-full bg-transparent px-1 py-1.5 text-fg outline-none focus-visible:shadow-none"
      />
    </EditableShell>
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Focus + select on entering edit (the ref/effect pattern InlineEdit uses —
  // avoids the autoFocus attribute, which biome flags for a11y).
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);
  // DISPLAY state (parity with every other field): plain text until clicked, so
  // the number field is NOT a permanently-lifted bordered box with native spinner
  // arrows. Click/Enter enters edit.
  if (!editing) {
    return (
      <DisplayBox
        ariaLabel={ariaLabel}
        isPending={isPending}
        onEdit={() => {
          setDraft(String(value));
          setEditing(true);
        }}
      >
        {value}
      </DisplayBox>
    );
  }
  // EDIT: the shell owns box metrics + the faint lift; the input fills it and
  // HIDES the native spinner arrows (NO_SPINNER) so it reads as plain text.
  return (
    <EditableShell mode="edit" isPending={isPending} className="w-full">
      <input
        ref={inputRef}
        type="number"
        aria-label={ariaLabel}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          const n = Number(draft);
          if (Number.isFinite(n) && n !== value) onCommit(n);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setDraft(String(value));
            setEditing(false);
          }
        }}
        className={cn(SHELL_INPUT, NO_SPINNER)}
      />
    </EditableShell>
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
      <DisplayBox ariaLabel={ariaLabel} isPending={isPending} onEdit={() => setEditing(true)}>
        {value || <span className="text-fg-3"> </span>}
      </DisplayBox>
    );
  }
  // EDIT input migrated to the shell (Task 7). The hard `w-44` (176px) overflowed
  // the date column (140px → now 160px) and clipped the native picker; the input
  // now fills its container (`w-full`) and the shell owns box metrics + focus/
  // pending treatment, matching NumberInput. All commit/Enter/Escape/blur
  // handlers are preserved verbatim.
  return (
    <EditableShell mode="edit" isPending={isPending} className="w-full">
      <input
        type="date"
        aria-label={ariaLabel}
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
        className={SHELL_INPUT}
      />
    </EditableShell>
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
          className="inline-flex items-center gap-1 rounded-sm bg-card px-1.5 py-0.5 text-sm text-fg"
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
    // DISPLAY: the shell owns box metrics + hover/pending; the <a> keeps ONLY its
    // link affordance (text-primary underline) + the metaKey/ctrlKey-opens-link /
    // plain-click-edits behavior. The shell's hover:bg-card layers under the
    // link's hover:underline — both are intentional.
    return (
      <EditableShell mode="display" isPending={isPending} className="w-full">
        <a
          href={value}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey) return;
            e.preventDefault();
            setEditing(true);
          }}
          className="block truncate text-primary underline-offset-2 hover:underline"
        >
          {value || '(empty)'}
        </a>
      </EditableShell>
    );
  }
  return (
    <EditableShell mode="edit" isPending={isPending} className="w-full">
      <input
        type="url"
        aria-label={ariaLabel}
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
        className={SHELL_INPUT}
      />
    </EditableShell>
  );
}

// Scheme guard — the single security mitigation for the image field.
// Rejects javascript:, data:, and any non-http(s) scheme so an attacker-supplied
// frontmatter value can never become an <img src> or be committed back. Empty is
// allowed (it clears the field).
function isSafeImageUrl(u: string): boolean {
  if (!u) return true;
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
}

// DELIBERATE shell carve-out (like TextArea's multi-line case): an image field
// is a thumbnail + URL input, not a single-line text box, so it keeps its own
// box styling and the `isSafeImageUrl` scheme guard rather than rendering
// through EditableShell. Not a sibling-audit miss.
function ImageField({
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
      <button
        type="button"
        aria-label={ariaLabel}
        onClick={() => setEditing(true)}
        className={cn(
          'inline-flex items-center rounded-md hover:bg-card',
          isPending && 'opacity-60',
        )}
      >
        {value && isSafeImageUrl(value) ? (
          <img
            src={value}
            alt={ariaLabel}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="h-16 w-16 rounded-md object-cover"
          />
        ) : (
          <span className="text-fg-3">{value || '(no image)'}</span>
        )}
      </button>
    );
  }
  return (
    <input
      type="url"
      aria-label={ariaLabel}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (draft !== value) {
          // Reject an unsafe scheme: revert the draft, never commit it.
          if (isSafeImageUrl(draft)) onCommit(draft);
          else setDraft(value);
        }
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
  const f = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  });
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
    // DISPLAY: right-aligned mono. The shell owns box metrics + right-align +
    // hover/pending; the inner element keeps only `font-mono`. The interactive
    // wrapper holds the enter-edit handlers.
    return (
      <DisplayBox
        ariaLabel={ariaLabel}
        align="right"
        isPending={isPending}
        className="font-mono"
        onEdit={() => setEditing(true)}
      >
        {value == null ? ' ' : formatter.format(value)}
      </DisplayBox>
    );
  }
  return (
    <EditableShell mode="edit" align="right" isPending={isPending} className="w-full font-mono">
      <input
        type="number"
        aria-label={ariaLabel}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          const n = Number(draft);
          if (Number.isFinite(n) && n !== value) onCommit(n);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setDraft(value == null ? '' : String(value));
            setEditing(false);
          }
        }}
        className={cn(SHELL_INPUT, 'text-right font-mono', NO_SPINNER)}
      />
    </EditableShell>
  );
}
