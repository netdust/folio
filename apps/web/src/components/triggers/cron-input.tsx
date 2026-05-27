import { useMemo } from 'react';
import { nextFires, validateCronShape } from '@folio/shared';
import { cn } from '../ui/cn.ts';

export interface CronInputProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}

type Validation =
  | { state: 'empty' }
  | { state: 'valid' }
  | { state: 'invalid'; reason?: string };

/**
 * Controlled cron-expression input with live validation and a 3-fire preview.
 *
 * - Renders a single-line text input.
 * - Live-validates via `validateCronShape` from `@folio/shared` (D1 export).
 * - Shows a green ✓ when valid, red ✗ when invalid.
 * - Below the input, previews `Next: <iso> · <iso> · <iso>` from `nextFires`.
 * - Preview + indicators hide when the value is empty.
 *
 * Consumed by `trigger-form.tsx` (D6).
 */
export function CronInput({
  value,
  onChange,
  placeholder,
  id,
  disabled,
  className,
}: CronInputProps) {
  const trimmed = value.trim();

  const validation: Validation = useMemo(() => {
    if (trimmed === '') return { state: 'empty' };
    const r = validateCronShape(trimmed);
    if (!r.ok) return { state: 'invalid', reason: r.reason };
    return { state: 'valid' };
  }, [trimmed]);

  const preview = useMemo(() => {
    if (validation.state !== 'valid') return [];
    return nextFires(trimmed, 3);
  }, [validation.state, trimmed]);

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className="block w-full rounded-md border border-border-light bg-shell px-3 py-2 font-mono text-sm text-fg input-focus disabled:opacity-50"
          aria-invalid={validation.state === 'invalid'}
        />
        {validation.state === 'valid' && (
          <span
            data-testid="cron-valid"
            className="text-success text-sm"
            aria-label="valid cron"
          >
            ✓
          </span>
        )}
        {validation.state === 'invalid' && (
          <span
            data-testid="cron-invalid"
            className="text-danger text-sm"
            aria-label={validation.reason ?? 'invalid cron'}
            title={validation.reason}
          >
            ✗
          </span>
        )}
      </div>
      {preview.length > 0 && (
        <div data-testid="cron-preview" className="text-xs text-fg-3 font-mono">
          Next: {preview.join(' · ')}
        </div>
      )}
    </div>
  );
}
