// localStorage access guarded for environments where it's unavailable or throws
// (tests, SSR, privacy mode, sandboxed iframes). Every accessor no-ops rather
// than throwing, so callers never need their own try/catch. The single shared
// guard (review #10 — it was hand-copied across agent-panel-bus, last-workspace,
// theme, and several others).

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function getStoredItem(key: string): string | null {
  return storage()?.getItem(key) ?? null;
}

export function setStoredItem(key: string, value: string): void {
  try {
    storage()?.setItem(key, value);
  } catch {
    // setItem can throw on quota-exceeded even when storage is present — ignore.
  }
}

export function removeStoredItem(key: string): void {
  storage()?.removeItem(key);
}
