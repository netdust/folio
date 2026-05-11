import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { cn } from './cn.ts';

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

interface SheetContentProps {
  children: ReactNode;
  className?: string;
  width?: number;
}

export function SheetContent({ children, className, width = 800 }: SheetContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className={cn(
          'fixed inset-0 z-40 bg-black/10',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
        )}
      />
      <DialogPrimitive.Content
        style={{ width: `min(${width}px, 100vw)` }}
        className={cn(
          'fixed right-0 top-0 z-50 h-screen bg-content shadow-popover',
          'flex flex-col',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right',
          'duration-slow ease-default',
          className,
        )}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
