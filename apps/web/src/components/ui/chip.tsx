import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn.ts';

interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value'> {
  filterKey: string;
  value: ReactNode;
}

// forwardRef is required so Radix's `<PopoverTrigger asChild>` (and other Slot
// consumers) can attach its ref to the underlying <button>. Without it Radix
// can't measure the trigger and the popover renders offscreen at the default
// `transform: translate(0, -200%)` position.
export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { filterKey, value, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
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
});

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
