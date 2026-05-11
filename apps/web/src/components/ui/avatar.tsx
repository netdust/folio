import { cn } from './cn.ts';

type Size = 'xs' | 'sm' | 'md';

interface AvatarProps {
  name: string;
  size?: Size;
  className?: string;
}

const sizeClasses: Record<Size, string> = {
  xs: 'h-[18px] w-[18px] text-[9px]',
  sm: 'h-[22px] w-[22px] text-[10px]',
  md: 'h-8 w-8 text-xs',
};

const toneClasses = [
  'bg-primary text-primary-fg',
  'bg-warning text-white',
  'bg-success text-white',
] as const;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0] ?? '').join('').toUpperCase() || '?';
}

function toneFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  return toneClasses[Math.abs(hash) % toneClasses.length] ?? toneClasses[0];
}

export function Avatar({ name, size = 'sm', className }: AvatarProps) {
  return (
    <span
      className={cn(
        'inline-grid place-items-center rounded-full font-medium',
        sizeClasses[size],
        toneFor(name),
        className,
      )}
      aria-label={name}
    >
      {initials(name)}
    </span>
  );
}
