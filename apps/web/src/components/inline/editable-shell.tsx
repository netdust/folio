import type { ReactNode } from 'react';
import { cn } from '../ui/cn.ts';

/**
 * Field size token. The single knob that resolves to the box-metric class set
 * (font-size + line-height + padding). Only `'sm'` exists today; the union is
 * the seam for future sizes without re-touching every consumer.
 */
export type FieldSize = 'sm';

// Box metrics — resolved ONLY from `size`, applied identically in both modes.
// Module-scope constant (not rebuilt per render; there are many shells per table).
const BOX_METRICS: Record<FieldSize, string> = {
  sm: 'text-sm px-1 py-0.5 rounded-sm',
};

/**
 * The classes a child <input>/<textarea> rendered INSIDE an EditableShell needs:
 * fill the shell's box, transparent (the shell owns bg), no native outline, and
 * suppress the global `*:focus-visible` box-shadow ring (which `outline-none`
 * does NOT cover). The shell owns the box; the child only fills it. Shared so the
 * load-bearing string can't drift across the ~5 inputs that use it.
 */
export const SHELL_INPUT = 'w-full bg-transparent text-fg outline-none focus-visible:shadow-none';

/** Hides the native number-spinner stepper (webkit) so number/currency read as
 *  plain text, not a stepper control. Appended to SHELL_INPUT on those inputs. */
export const NO_SPINNER =
  '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none';

interface EditableShellProps {
  /** Whether the field is displaying its value or being edited. NEVER affects box metrics. */
  mode: 'display' | 'edit';
  /** Resolves the box-metric class set. Default `'sm'`. */
  size?: FieldSize;
  /** Text alignment (NOT a box-metric). Default `'left'`. */
  align?: 'left' | 'right';
  /** Optimistic-write treatment — dims the box while the mutation is in flight. */
  isPending?: boolean;
  /** Per-call layout passthrough (e.g. `w-full truncate`). Merged LAST via `cn`. */
  className?: string;
  children: ReactNode;
}

/**
 * The single styling convergence point for inline field appearance.
 *
 * Box-equivalence invariant (load-bearing): the wrapper's box metrics
 * (font-size, line-height, padding, radius) are determined ENTIRELY by `size`
 * (+ `align` for text-align, which is not a box-metric) and are IDENTICAL across
 * `mode`. `mode` may only toggle the hover affordance / focus-ring treatment.
 * This is what kills the "font gets bigger when editing" layout-shift bug.
 */
export function EditableShell({
  mode,
  size = 'sm',
  align = 'left',
  isPending = false,
  className,
  children,
}: EditableShellProps) {
  return (
    <span
      data-state={mode}
      className={cn(
        BOX_METRICS[size],
        // Center content vertically at the ROOT so every field — incl. the date,
        // whose native control is taller — sits on one midline regardless of the
        // wrapper chain above it. Applied in BOTH modes so box-equivalence holds.
        // `inline-flex` keeps the shell shrink-to-content like a plain inline
        // span; consumers needing full width pass `w-full` (not `block`).
        'inline-flex items-center',
        align === 'right' && 'justify-end',
        // Smooth hover-bg (locked refined-motion decision) — transition-colors
        // does NOT change box metrics.
        'transition-colors duration-150 ease-out',
        // Mode treatment — background affordance ONLY, never box metrics.
        // Display hints editability on hover; edit lifts onto a faint card bg
        // with NO border/ring (the bg lift is the whole "you're editing" signal
        // — a ring/border read too heavy). The global `*:focus-visible` rule in
        // globals.css paints a box-shadow ring on the focused child input, which
        // `outline-none` does NOT suppress — so kill it for the shell's inputs
        // via the descendant variant, keeping edit mode ring-free.
        mode === 'display' && 'hover:bg-card',
        mode === 'edit' &&
          'bg-card [&_input]:focus-visible:shadow-none [&_textarea]:focus-visible:shadow-none',
        align === 'right' && 'text-right',
        isPending && 'opacity-60',
        className,
      )}
    >
      {children}
    </span>
  );
}

interface DisplayBoxProps {
  /** Enter edit mode (click or Enter/Space). */
  onEdit: () => void;
  align?: 'left' | 'right';
  isPending?: boolean;
  /** Accessible name for the interactive display affordance (role=button). */
  ariaLabel?: string;
  /** Extra classes for the inner shell (e.g. `font-mono` for currency). */
  className?: string;
  children: ReactNode;
}

/**
 * The click-to-edit DISPLAY affordance shared by the field-renderer fields that
 * have a display state (Date/Number/Currency): an interactive, keyboard-
 * accessible wrapper around an `EditableShell mode="display"`. Centralizes the
 * `role`/`tabIndex`/`onClick`/`onKeyDown` a11y wiring so it can't rot per-field
 * (one site forgetting `onKeyDown` = a keyboard-inaccessible field). The shell
 * fills its parent (`w-full`) and the wrapper centers it on the row midline.
 *
 * NOTE: InlineEdit's display branch deliberately does NOT use this — its wrapper
 * is `block min-w-0` + shell `w-full truncate` for title ellipsis, a load-bearing
 * layout difference from this `flex items-center` centering wrapper.
 */
export function DisplayBox({
  onEdit,
  align,
  isPending,
  ariaLabel,
  className,
  children,
}: DisplayBoxProps) {
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      onClick={onEdit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onEdit();
      }}
      className="flex w-full cursor-text items-center focus:outline-none"
    >
      <EditableShell
        mode="display"
        align={align}
        isPending={isPending}
        className={cn('w-full', className)}
      >
        {children}
      </EditableShell>
    </span>
  );
}
