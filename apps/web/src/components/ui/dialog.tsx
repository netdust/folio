import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { cn } from './cn.ts';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

interface DialogContentProps {
  children: ReactNode;
  className?: string;
}

export function DialogContent({ children, className }: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className={cn(
          'fixed inset-0 z-40 bg-black/30',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
        )}
      />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
          'w-[440px] max-w-[92vw] rounded-lg bg-content shadow-popover',
          'p-6',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
          'data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95',
          className,
        )}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogTitle({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <DialogPrimitive.Title className={cn('text-base font-medium tracking-tight', className)}>
      {children}
    </DialogPrimitive.Title>
  );
}

export function DialogDescription({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <DialogPrimitive.Description className={cn('mt-2 text-sm text-fg-2', className)}>
      {children}
    </DialogPrimitive.Description>
  );
}
