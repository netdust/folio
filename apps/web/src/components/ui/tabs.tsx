import { cn } from './cn.ts';

interface TabsProps<T extends string> {
  value: T;
  onChange: (next: T) => void;
  items: Array<{ value: T; label: string }>;
}

export function Tabs<T extends string>({ value, onChange, items }: TabsProps<T>) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md border border-border-light bg-shell p-0.5 text-xs">
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={value === item.value}
          onClick={() => { if (value !== item.value) onChange(item.value); }}
          className={cn(
            'rounded-sm px-2 py-1',
            value === item.value ? 'bg-primary text-primary-fg' : 'text-fg-2 hover:bg-card',
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
