import { Command as CommandPrimitive } from 'cmdk';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from './cn.ts';

export function Command({ className, ...props }: ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      className={cn('flex flex-col overflow-hidden rounded-lg bg-content', className)}
      {...props}
    />
  );
}

export function CommandInput({ className, ...props }: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <CommandPrimitive.Input
      className={cn(
        'border-b border-border-light bg-transparent px-3 py-2.5 text-sm',
        'focus:outline-none placeholder:text-fg-3',
        className,
      )}
      {...props}
    />
  );
}

export function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      className={cn('folio-scroll max-h-[320px] overflow-auto p-1.5', className)}
      {...props}
    />
  );
}

export function CommandEmpty(props: ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty className="py-6 text-center text-sm text-fg-3" {...props} />;
}

interface CommandGroupProps extends ComponentProps<typeof CommandPrimitive.Group> {
  heading?: ReactNode;
}

export function CommandGroup({ className, heading, ...props }: CommandGroupProps) {
  return (
    <CommandPrimitive.Group
      heading={
        heading ? (
          <span className="px-2.5 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-fg-3">
            {heading}
          </span>
        ) : undefined
      }
      className={cn('text-sm text-fg', className)}
      {...props}
    />
  );
}

export function CommandItem({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        'flex items-center gap-2.5 rounded-md px-2.5 py-1.5',
        'cursor-pointer aria-selected:bg-card',
        className,
      )}
      {...props}
    />
  );
}
