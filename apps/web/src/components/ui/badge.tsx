import type { ReactNode } from 'react';
import { cn } from './cn.ts';

type Variant = 'high' | 'medium' | 'low' | 'label';
type LabelTone = 'success' | 'danger' | 'warning' | 'info';

interface BadgeProps {
  variant: Variant;
  tone?: LabelTone;
  children: ReactNode;
  className?: string;
}

const variantClasses: Record<Exclude<Variant, 'label'>, string> = {
  high:   'bg-bg-danger text-danger',
  medium: 'bg-card text-fg-2',
  low:    'bg-card text-fg-3',
};

const labelClasses: Record<LabelTone, string> = {
  success: 'bg-bg-success text-success',
  danger:  'bg-bg-danger text-danger',
  warning: 'bg-bg-warning text-warning',
  info:    'bg-bg-info text-info',
};

export function Badge({ variant, tone, children, className }: BadgeProps) {
  const cls = variant === 'label' ? labelClasses[tone ?? 'info'] : variantClasses[variant];
  return (
    <span
      className={cn(
        'inline-block px-2 py-0.5 rounded-sm text-[10px] font-medium',
        cls,
        className,
      )}
    >
      {children}
    </span>
  );
}

export function labelTone(label: string): LabelTone {
  const tones: LabelTone[] = ['success', 'danger', 'warning', 'info'];
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = (hash << 5) - hash + label.charCodeAt(i);
    hash |= 0;
  }
  const idx = Math.abs(hash) % tones.length;
  return tones[idx] ?? 'info';
}
