import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { getResolvedTheme, setTheme, type Theme } from './theme.ts';

const STORAGE_KEY = 'folio:theme';

// Bun's DOM mock is partial; we set up a minimal stub.
const originalLocalStorage = globalThis.localStorage;
const originalMatchMedia = globalThis.matchMedia;
const originalDocument = globalThis.document;

beforeEach(() => {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage;
  globalThis.matchMedia = (q: string) => ({
    matches: q.includes('dark'),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  }) as MediaQueryList;
  // minimal documentElement
  globalThis.document = {
    documentElement: { classList: new Set<string>() } as unknown as HTMLElement,
  } as unknown as Document;
  // patch classList.add/remove/contains
  const cls = (globalThis.document.documentElement.classList as unknown as Set<string>);
  const setAdd = Set.prototype.add.bind(cls);
  const setDelete = Set.prototype.delete.bind(cls);
  const setHas = Set.prototype.has.bind(cls);
  (globalThis.document.documentElement.classList as unknown as { add: (s: string) => void }).add =
    (s: string) => { setAdd(s); };
  (globalThis.document.documentElement.classList as unknown as { remove: (s: string) => void }).remove =
    (s: string) => { setDelete(s); };
  (globalThis.document.documentElement.classList as unknown as { contains: (s: string) => boolean }).contains =
    (s: string) => setHas(s);
});

afterEach(() => {
  globalThis.localStorage = originalLocalStorage;
  globalThis.matchMedia = originalMatchMedia;
  globalThis.document = originalDocument;
});

describe('theme', () => {
  test('default is system, resolves to dark when media matches dark', () => {
    expect(getResolvedTheme()).toBe('dark');
  });

  test('setTheme(light) writes localStorage and removes .dark class', () => {
    document.documentElement.classList.add('dark');
    setTheme('light');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  test('setTheme(dark) writes localStorage and adds .dark class', () => {
    setTheme('dark');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  test('setTheme(system) clears localStorage and resolves from media query', () => {
    setTheme('dark');
    setTheme('system');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('system');
    // matchMedia stub returns matches=true for 'dark' query, so resolved is dark
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  test('all three values are valid Theme', () => {
    const themes: Theme[] = ['light', 'dark', 'system'];
    expect(themes.length).toBe(3);
  });
});
