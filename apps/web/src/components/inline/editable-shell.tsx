import type { ReactNode } from 'react';
import { cn } from '../ui/cn.ts';

/**
 * Field size token. The single knob that resolves to the box-metric class set
 * (font-size + line-height + padding). Only `'sm'` exists today; the union is
 * the seam for future sizes without re-touching every consumer.
 */
export type FieldSize = 'sm';

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
  // Box metrics — resolved ONLY from `size`, applied identically in both modes.
  const boxMetrics: Record<FieldSize, string> = {
    sm: 'text-sm px-1 py-0.5 rounded-sm',
  };

  return (
    <span
      data-state={mode}
      className={cn(
        boxMetrics[size],
        // Smooth hover-bg (locked refined-motion decision) — transition-colors
        // does NOT change box metrics.
        'transition-colors duration-150 ease-out',
        // Mode treatment — focus-ring / hover affordance ONLY, never box metrics.
        mode === 'display' && 'hover:bg-card',
        mode === 'edit' && 'input-focus bg-card',
        align === 'right' && 'text-right',
        isPending && 'opacity-60',
        className,
      )}
    >
      {children}
    </span>
  );
}
