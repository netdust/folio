import { Plus } from 'lucide-react';
import { useState } from 'react';
import { IconButton } from '../ui/icon-button.tsx';
import { Icon } from '../ui/icon.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover.tsx';
import type { FieldType } from '../../lib/api/fields.ts';

const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: 'string', label: 'Text (single line)' },
  { value: 'text', label: 'Text (multi-line)' },
  { value: 'number', label: 'Number' },
  { value: 'currency', label: 'Currency' },
  { value: 'boolean', label: 'Checkbox' },
  { value: 'date', label: 'Date' },
  { value: 'datetime', label: 'Date & time' },
  { value: 'select', label: 'Select (one of)' },
  { value: 'multi_select', label: 'Multi-select' },
  { value: 'user_ref', label: 'User' },
  { value: 'url', label: 'URL' },
  { value: 'document_ref', label: 'Document link' },
  { value: 'relation', label: 'Relation (link to docs)' },
];

const KEY_RE = /^[a-z][a-z0-9_]*$/;
const ISO_RE = /^[A-Z]{3}$/;

function titleize(key: string): string {
  return key
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export interface AddColumnPayload {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
}

interface Props {
  onSubmit: (payload: AddColumnPayload) => Promise<void> | void;
  tables?: { id: string; name: string }[];
}

export function TableAddColumn({ onSubmit, tables = [] }: Props) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [type, setType] = useState<FieldType>('string');
  const [optionsText, setOptionsText] = useState('');
  const [currencyCode, setCurrencyCode] = useState('EUR');
  const [relTarget, setRelTarget] = useState('wiki');
  const [relCardinality, setRelCardinality] = useState<'single' | 'multi'>('single');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function reset() {
    setKey('');
    setLabel('');
    setType('string');
    setOptionsText('');
    setCurrencyCode('EUR');
    setRelTarget('wiki');
    setRelCardinality('single');
    setError(null);
    setSubmitting(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!KEY_RE.test(key)) {
      setError(
        'Key must start with a lowercase letter and contain only lowercase letters, numbers, underscore.',
      );
      return;
    }
    let options: string[] | undefined;
    if (type === 'select' || type === 'multi_select') {
      const parsed = optionsText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (parsed.length === 0) {
        setError(`${type} requires at least one option.`);
        return;
      }
      options = parsed;
    } else if (type === 'currency') {
      if (!ISO_RE.test(currencyCode)) {
        setError('Currency requires a 3-letter ISO-4217 code (e.g. EUR, USD).');
        return;
      }
      options = [currencyCode];
    } else if (type === 'relation') {
      options = [relTarget, relCardinality];
    }
    const finalLabel = label.trim() || titleize(key);

    setSubmitting(true);
    try {
      const payload: AddColumnPayload = { key, label: finalLabel, type };
      if (options) payload.options = options;
      await onSubmit(payload);
      reset();
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create column.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) {
          reset();
        }
      }}
    >
      <PopoverTrigger asChild>
        <IconButton label="Add column" size="sm">
          <Icon icon={Plus} size={14} />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[280px] p-3">
        <form className="flex flex-col gap-2" onSubmit={handleSubmit}>
          <label
            className="text-[11px] uppercase tracking-wide text-fg-3"
            htmlFor="add-col-key"
          >
            Key
          </label>
          <input
            id="add-col-key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="e.g. next_action"
            className="rounded-sm border border-border-light bg-content px-2 py-1 text-sm outline-none focus:border-border"
            autoFocus
          />

          <label
            className="text-[11px] uppercase tracking-wide text-fg-3"
            htmlFor="add-col-label"
          >
            Label
          </label>
          <input
            id="add-col-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="auto-derived from key"
            className="rounded-sm border border-border-light bg-content px-2 py-1 text-sm outline-none focus:border-border"
          />

          <label
            className="text-[11px] uppercase tracking-wide text-fg-3"
            htmlFor="add-col-type"
          >
            Type
          </label>
          <select
            id="add-col-type"
            value={type}
            onChange={(e) => setType(e.target.value as FieldType)}
            className="rounded-sm border border-border-light bg-content px-2 py-1 text-sm outline-none focus:border-border"
          >
            {FIELD_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>

          {type === 'select' || type === 'multi_select' ? (
            <>
              <label
                className="text-[11px] uppercase tracking-wide text-fg-3"
                htmlFor="add-col-options"
              >
                Options (comma-separated)
              </label>
              <input
                id="add-col-options"
                value={optionsText}
                onChange={(e) => setOptionsText(e.target.value)}
                placeholder="low, medium, high"
                className="rounded-sm border border-border-light bg-content px-2 py-1 text-sm outline-none focus:border-border"
              />
            </>
          ) : null}

          {type === 'currency' ? (
            <>
              <label
                className="text-[11px] uppercase tracking-wide text-fg-3"
                htmlFor="add-col-iso"
              >
                ISO code
              </label>
              <input
                id="add-col-iso"
                value={currencyCode}
                onChange={(e) => setCurrencyCode(e.target.value.toUpperCase())}
                maxLength={3}
                placeholder="EUR"
                className="rounded-sm border border-border-light bg-content px-2 py-1 text-sm outline-none focus:border-border"
              />
            </>
          ) : null}

          {type === 'relation' ? (
            <>
              <label
                className="text-[11px] uppercase tracking-wide text-fg-3"
                htmlFor="add-col-rel-target"
              >
                Links to
              </label>
              <select
                id="add-col-rel-target"
                aria-label="Links to"
                value={relTarget}
                onChange={(e) => setRelTarget(e.target.value)}
                className="rounded-sm border border-border-light bg-content px-2 py-1 text-sm outline-none focus:border-border"
              >
                <option value="wiki">Wiki / Pages</option>
                {tables.map((t) => (
                  <option key={t.id} value={`table:${t.id}`}>
                    {t.name}
                  </option>
                ))}
              </select>

              <label
                className="text-[11px] uppercase tracking-wide text-fg-3"
                htmlFor="add-col-rel-card"
              >
                Cardinality
              </label>
              <select
                id="add-col-rel-card"
                aria-label="Cardinality"
                value={relCardinality}
                onChange={(e) => setRelCardinality(e.target.value as 'single' | 'multi')}
                className="rounded-sm border border-border-light bg-content px-2 py-1 text-sm outline-none focus:border-border"
              >
                <option value="single">Single link</option>
                <option value="multi">Multiple links</option>
              </select>
            </>
          ) : null}

          {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}

          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                reset();
                setOpen(false);
              }}
              className="rounded-sm px-2 py-1 text-sm text-fg-3 hover:text-fg-2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!key || submitting}
              className="rounded-sm bg-fg-1 px-2 py-1 text-sm text-content disabled:opacity-50"
            >
              Create
            </button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
