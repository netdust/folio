import { Kbd } from '../ui/kbd.tsx';
import { cn } from '../ui/cn.ts';

export type EditorMode = 'rich' | 'raw';

interface Props {
  mode: EditorMode;
  onChange: (mode: EditorMode) => void;
}

export function ModeToggle({ mode, onChange }: Props) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-md border border-border-light bg-shell p-0.5 text-xs">
      <button
        type="button"
        onClick={() => onChange('rich')}
        className={cn(
          'rounded-sm px-2 py-1',
          mode === 'rich' ? 'bg-primary text-primary-fg' : 'text-fg-2 hover:bg-card',
        )}
      >
        Edit
      </button>
      <button
        type="button"
        onClick={() => onChange('raw')}
        className={cn(
          'rounded-sm px-2 py-1',
          mode === 'raw' ? 'bg-primary text-primary-fg' : 'text-fg-2 hover:bg-card',
        )}
      >
        Raw MD <Kbd>⌥M</Kbd>
      </button>
    </div>
  );
}
