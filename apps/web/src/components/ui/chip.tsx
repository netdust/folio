import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react';
import { cn } from './cn.ts';

// =============================================================================
// Generic content-tag Chip (Phase 2.5 — design system primitive).
//
// Use this for project names, tool names, "removed" placeholders, status labels
// that don't fit the categorized `Pill`. Two variants:
//
//   <Chip>project-a</Chip>            // default — neutral chip, visible border
//   <Chip muted>removed</Chip>        // muted — no border, fg-3 text
//   <Chip onClick={fn}>folio</Chip>   // interactive — primary tint on hover
//   <Chip mono>list_documents</Chip>  // mono — for code-like values (tool names)
//
// Replaces three ad-hoc <Chip>/<ProjectChip> definitions that diverged during
// the second-sweep polish in shake-out. New chip use should ALWAYS go through
// this primitive; if your need doesn't fit the variants, discuss instead of
// adding a fourth.
// =============================================================================

type SharedChipProps = {
  children: ReactNode;
  muted?: boolean;
  mono?: boolean;
};

type StaticChipProps = SharedChipProps & Omit<HTMLAttributes<HTMLSpanElement>, keyof SharedChipProps>;
type InteractiveChipProps = SharedChipProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof SharedChipProps> & {
    onClick: ButtonHTMLAttributes<HTMLButtonElement>['onClick'];
  };

type ChipProps = StaticChipProps | InteractiveChipProps;

function chipClasses(opts: { muted?: boolean; mono?: boolean; interactive: boolean }): string {
  return cn(
    // rounded-md (not rounded-full) + border-border-light (not border-border)
    // — softer at-rest weight so a row of chips next to long-form text doesn't
    // visually dominate the surface. BUG-012.
    'inline-flex items-center rounded-md px-2 py-0.5 text-[11px] transition-colors duration-fast',
    opts.mono && 'font-mono',
    opts.muted
      ? 'bg-card text-fg-3'
      : // Default — visible at rest with a lighter border (matches the slideover
        // divider weight) so the chip body never disappears but doesn't shout.
        'border border-border-light bg-card text-fg-2',
    // Interactive default gets a primary hover tint to telegraph the action.
    // Interactive muted gets a subtle hover but no tint — staying out of the
    // way is the variant's whole point.
    opts.interactive && !opts.muted && 'hover:border-primary/30 hover:bg-primary/10 hover:text-primary',
    opts.interactive && opts.muted && 'hover:text-fg-2',
  );
}

// forwardRef so Radix's `<PopoverTrigger asChild>` can attach its ref. The
// existing FilterChipValue + ChipAdd patterns established this requirement;
// staying consistent means consumers don't have to think about which chip
// supports Radix and which doesn't.
export const Chip = forwardRef<HTMLButtonElement | HTMLSpanElement, ChipProps>(function Chip(
  props,
  ref,
) {
  const { children, muted, mono, ...rest } = props as ChipProps & { onClick?: unknown };
  // Discriminate by presence of onClick — interactive chips render as
  // <button>, static chips as <span>. Same dispatch the old ProjectChip used.
  if (typeof (rest as { onClick?: unknown }).onClick === 'function') {
    const interactive = rest as ButtonHTMLAttributes<HTMLButtonElement>;
    return (
      <button
        ref={ref as Ref<HTMLButtonElement>}
        type="button"
        {...interactive}
        className={cn(chipClasses({ muted, mono, interactive: true }), interactive.className)}
      >
        {children}
      </button>
    );
  }
  const staticRest = rest as HTMLAttributes<HTMLSpanElement>;
  return (
    <span
      ref={ref as Ref<HTMLSpanElement>}
      {...staticRest}
      className={cn(chipClasses({ muted, mono, interactive: false }), staticRest.className)}
    >
      {children}
    </span>
  );
});

// =============================================================================
// Filter-bar chips (pre-existing, not migrated). These have specialized
// `filterKey + value` semantics that don't fit the generic Chip vocabulary.
// FilterChipValue is the renamed-from-Chip version; ChipAdd is unchanged.
// =============================================================================

interface FilterChipValueProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value'> {
  filterKey: string;
  value: ReactNode;
}

/**
 * Filter-bar chip: a button rendering `<key> <value>` with the filter-bar
 * styling. Used by the design system docs page; FilterChip in components/filter/
 * is the production filter-bar chip (carries a remove button on top of this).
 */
export const FilterChipValue = forwardRef<HTMLButtonElement, FilterChipValueProps>(
  function FilterChipValue({ filterKey, value, className, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        {...rest}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-pill bg-card px-2.5 py-0.5 text-xs',
          'hover:brightness-95 transition duration-fast ease-default',
          className,
        )}
      >
        <span className="text-fg-3">{filterKey}</span>
        <span className="font-medium text-fg">{value}</span>
      </button>
    );
  },
);

interface ChipAddProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label?: string;
}

export const ChipAdd = forwardRef<HTMLButtonElement, ChipAddProps>(function ChipAdd(
  { label = '+ Filter', className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      {...rest}
      className={cn(
        'inline-flex items-center rounded-pill border border-dashed border-fg-3',
        'px-2.5 py-0.5 text-xs text-fg-2',
        'hover:text-fg hover:border-fg-2 transition-colors duration-fast',
        className,
      )}
    >
      {label}
    </button>
  );
});
