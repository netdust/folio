import { useEffect, useState } from 'react';
import { getStoredTheme, setTheme as applyTheme, type Theme } from '../../lib/theme.ts';
import { cn } from './cn.ts';

export function ThemeToggle() {
  const [theme, setLocal] = useState<Theme>('system');
  useEffect(() => { setLocal(getStoredTheme()); }, []);
  const choose = (t: Theme) => { setLocal(t); applyTheme(t); };

  return (
    <div className="inline-flex items-center gap-0 rounded p-0.5 bg-card">
      {(['light', 'system', 'dark'] as Theme[]).map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => choose(t)}
          className={cn(
            'rounded-sm px-2.5 py-0.5 text-[11px] font-medium transition-colors duration-fast',
            theme === t ? 'bg-content text-fg shadow-card' : 'text-fg-2 hover:text-fg',
          )}
        >
          {t.charAt(0).toUpperCase() + t.slice(1)}
        </button>
      ))}
    </div>
  );
}
