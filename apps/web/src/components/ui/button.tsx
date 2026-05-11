import type { ButtonHTMLAttributes } from 'react';
import { cn } from './cn.ts';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

const variantClasses: Record<Variant, string> = {
  primary:   'bg-primary text-primary-fg hover:opacity-90',
  secondary: 'bg-card text-fg hover:brightness-95',
  ghost:     'text-fg-2 hover:bg-card hover:text-fg',
  danger:    'bg-danger text-fg-on-primary hover:opacity-90',
};

const sizeClasses: Record<Size, string> = {
  sm: 'h-6 px-3 text-xs gap-1.5',
  md: 'h-7 px-3.5 text-xs gap-1.5',
  lg: 'h-8 px-4 text-sm gap-2',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  className,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center rounded-pill font-medium',
        'transition-opacity duration-fast ease-default',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
    >
      {loading ? <Spinner /> : children}
    </button>
  );
}

function Spinner() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" className="animate-spin">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
