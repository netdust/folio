import * as PopoverPrimitive from '@radix-ui/react-popover';
import type { ReactNode } from 'react';
import { cn } from './cn.ts';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

interface PopoverContentProps {
  children: ReactNode;
  className?: string;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  sideOffset?: number;
}

export function PopoverContent({
  children,
  className,
  align = 'start',
  side = 'bottom',
  sideOffset = 4,
}: PopoverContentProps) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        side={side}
        sideOffset={sideOffset}
        className={cn(
          'z-50 rounded-lg bg-content shadow-popover p-1.5',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
          className,
        )}
      >
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}
