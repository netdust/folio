import { type LucideIcon } from 'lucide-react';
import { cn } from './cn.ts';

interface Props {
  icon: LucideIcon;
  size?: 14 | 16 | 20 | 24;
  className?: string;
  label?: string;
}

export function Icon({ icon: I, size = 16, className, label }: Props) {
  return (
    <I
      strokeWidth={1.5}
      width={size}
      height={size}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn('shrink-0', className)}
    />
  );
}
