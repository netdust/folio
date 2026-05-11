import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn.ts';

type Size = 'sm' | 'md' | 'lg';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: Size;
  active?: boolean;
  label: string;
  children: ReactNode;
}

const sizeClasses: Record<Size, string> = {
  sm: 'h-[26px] w-[26px] rounded-sm',
  md: 'h-8 w-8 rounded-md',
  lg: 'h-10 w-10 rounded-md',
};

export function IconButton({
  size = 'md',
  active = false,
  label,
  className,
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={cn(
        'inline-grid place-items-center',
        'text-fg-3 hover:text-fg-2 hover:bg-card',
        'transition-colors duration-fast ease-default',
        active && 'text-fg bg-card',
        sizeClasses[size],
        className,
      )}
    >
      {children}
    </button>
  );
}
