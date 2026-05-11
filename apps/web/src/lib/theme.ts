const STORAGE_KEY = 'folio:theme';

export type Theme = 'light' | 'dark' | 'system';

export function getStoredTheme(): Theme {
  const v = localStorage.getItem(STORAGE_KEY);
  if (v === 'light' || v === 'dark' || v === 'system') return v;
  return 'system';
}

export function getResolvedTheme(): 'light' | 'dark' {
  const stored = getStoredTheme();
  if (stored === 'system') {
    return globalThis.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return stored;
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEY, theme);
  applyResolvedTheme();
}

export function applyResolvedTheme(): void {
  const resolved = getResolvedTheme();
  if (resolved === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}
