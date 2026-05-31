import { type LucideIcon } from 'lucide-react';
import { Icon } from '../ui/icon.tsx';
import { cn } from '../ui/cn.ts';

export interface HeaderTabItem<T extends string> {
  value: T;
  /** Accessible name — shown as the button's aria-label + native tooltip (icon-only UI). */
  label: string;
  icon: LucideIcon;
  /** Optional badge (e.g. comment count); hidden when 0/undefined. */
  count?: number;
}

export interface HeaderTabsProps<T extends string> {
  value: T;
  items: HeaderTabItem<T>[];
  onChange: (next: T) => void;
}

/**
 * NocoDB-style icon-only tab toggles for a slideover header — a compact
 * segmented group that lives inline in the header row (no separate tab line).
 * The name is carried by aria-label + the native title tooltip.
 */
export function HeaderTabs<T extends string>({ value, items, onChange }: HeaderTabsProps<T>) {
  return (
    <div role="tablist" className="flex items-center gap-0.5 rounded-md bg-card p-0.5">
      {items.map((item) => {
        const active = value === item.value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-label={item.label}
            aria-selected={active}
            title={item.label}
            onClick={() => {
              if (!active) onChange(item.value);
            }}
            className={cn(
              'relative grid h-7 w-7 place-items-center rounded transition-colors',
              active ? 'bg-content text-fg shadow-sm' : 'text-fg-3 hover:text-fg-2',
            )}
          >
            <Icon icon={item.icon} size={16} />
            {item.count != null && item.count > 0 ? (
              <span className="absolute -right-0.5 -top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-primary px-0.5 text-[9px] leading-none text-bg">
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
