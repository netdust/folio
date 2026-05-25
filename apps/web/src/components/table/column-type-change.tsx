import { useState } from 'react';
import type { FieldType } from '../../lib/api/fields.ts';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../ui/dialog.tsx';
import { Button } from '../ui/button.tsx';

const ISO_RE = /^[A-Z]{3}$/;

interface Props {
  currentType: FieldType;
  currentOptions: string[] | null;
  open: boolean;
  onClose: () => void;
  onSubmit: (payload: { type: FieldType; options?: string[] | null }) => Promise<void>;
}

function compatibleTargets(from: FieldType): FieldType[] {
  // Mirror the server matrix exactly; the server is the source of truth, this
  // just keeps incompatible options out of the dropdown so users don't fight
  // the form.
  if (from === 'string') return ['text'];
  if (from === 'text') return ['string'];
  if (from === 'number') return ['currency', 'text'];
  if (from === 'currency') return ['number', 'text'];
  return ['text'];
}

export function ColumnTypeChange({ currentType, currentOptions, open, onClose, onSubmit }: Props) {
  const targets = compatibleTargets(currentType);
  const [target, setTarget] = useState<FieldType>(targets[0] ?? 'text');
  const [iso, setIso] = useState(currentOptions?.[0] ?? 'EUR');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleApply() {
    setError(null);
    let options: string[] | null | undefined;
    if (target === 'currency' && currentType !== 'currency') {
      if (!ISO_RE.test(iso)) {
        setError('Currency requires a 3-letter ISO-4217 code (e.g. EUR, USD).');
        return;
      }
      options = [iso];
    } else if (currentType === 'currency' && target !== 'currency') {
      options = null;
    }
    setSubmitting(true);
    try {
      const payload: { type: FieldType; options?: string[] | null } = { type: target };
      if (options !== undefined) payload.options = options;
      await onSubmit(payload);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change type.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !submitting) onClose(); }}>
      <DialogContent>
        <DialogTitle>Change column type</DialogTitle>
        <DialogDescription>
          Current: <code>{currentType}</code>. Pick a compatible new type. Values that don't fit the new type remain in raw frontmatter but the cell renderer changes.
        </DialogDescription>
        <div className="mt-3 flex flex-col gap-2">
          <label className="text-[11px] uppercase tracking-wide text-fg-3" htmlFor="ctc-type">New type</label>
          <select
            id="ctc-type"
            value={target}
            onChange={(e) => setTarget(e.target.value as FieldType)}
            className="rounded-sm border border-border-light bg-content px-2 py-1 text-sm outline-none focus:border-border"
          >
            {targets.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>

          {target === 'currency' && currentType !== 'currency' ? (
            <>
              <label className="text-[11px] uppercase tracking-wide text-fg-3" htmlFor="ctc-iso">ISO code</label>
              <input
                id="ctc-iso"
                value={iso}
                onChange={(e) => setIso(e.target.value.toUpperCase())}
                maxLength={3}
                placeholder="EUR"
                className="rounded-sm border border-border-light bg-content px-2 py-1 text-sm outline-none focus:border-border"
              />
            </>
          ) : null}

          {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button variant="primary" onClick={() => void handleApply()} disabled={submitting || target === currentType}>
            Apply
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
