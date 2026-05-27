import { cn } from './cn.ts';

export interface TabItem<T extends string> {
  value: T;
  label: string;
  icon?: string;
  count?: number;
}

export interface TabStripProps<T extends string> {
  value: T;
  items: TabItem<T>[];
  onChange: (next: T) => void;
}

export function TabStrip<T extends string>({ value, items, onChange }: TabStripProps<T>) {
  return (
    <div role="tablist" className="flex items-center gap-1 border-b border-border-light">
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-pressed={value === item.value}
          onClick={() => {
            if (value !== item.value) onChange(item.value);
          }}
          className={cn(
            'flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors',
            value === item.value
              ? 'border-primary text-fg'
              : 'border-transparent text-fg-2 hover:text-fg',
          )}
        >
          {item.icon ? <span aria-hidden>{item.icon}</span> : null}
          <span>{item.label}</span>
          {item.count != null && item.count > 0 ? (
            <span className="ml-0.5 rounded-full bg-shell px-1.5 text-[10px] text-fg-2">
              {item.count}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
