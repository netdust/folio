import type { ReactNode } from 'react';
import { cn } from './cn.ts';

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex items-center rounded-sm bg-card px-1.5 py-0.5',
        'font-mono text-[10px] text-fg-2',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
