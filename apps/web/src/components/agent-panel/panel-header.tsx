import { type LucideIcon, X } from 'lucide-react';
import { Icon } from '../ui/icon.tsx';

export interface PanelTab<T extends string> {
  value: T;
  icon: LucideIcon;
  label: string;
}

interface PanelHeaderProps<T extends string> {
  title: string;
  tabs: PanelTab<T>[];
  active: T;
  onTab: (t: T) => void;
  onClose: () => void;
}

export function PanelHeader<T extends string>({
  title,
  tabs,
  active,
  onTab,
  onClose,
}: PanelHeaderProps<T>) {
  return (
    <div className="flex items-center gap-2 border-b border-border-light px-3 py-2.5">
      <strong className="flex-1 truncate text-fg">{title}</strong>
      <div className="flex gap-0.5 rounded-md bg-card p-0.5">
        {tabs.map((t) => (
          <button
            key={t.value}
            type="button"
            aria-label={t.label}
            aria-pressed={active === t.value}
            onClick={() => onTab(t.value)}
            className={`grid h-7 w-7 place-items-center rounded ${
              active === t.value
                ? 'bg-content text-fg shadow-sm'
                : 'text-fg-3 hover:text-fg-2'
            }`}
          >
            <Icon icon={t.icon} size={16} />
          </button>
        ))}
      </div>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="grid h-6 w-6 place-items-center rounded text-fg-3 hover:bg-card hover:text-fg"
      >
        <Icon icon={X} size={16} />
      </button>
    </div>
  );
}
