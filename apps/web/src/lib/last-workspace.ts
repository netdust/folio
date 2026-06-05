import { getStoredItem, setStoredItem } from './safe-storage.ts';

const STORAGE_KEY = 'folio:last-workspace-slug';

// Remembers the workspace the user was last in, so the root landing route can
// reopen it instead of dumping the user on the all-workspaces grid. Storage
// access is guarded by the shared safe-storage helper (no-ops without
// localStorage — tests, SSR, privacy mode).

export function getLastWorkspaceSlug(): string | null {
  return getStoredItem(STORAGE_KEY);
}

export function setLastWorkspaceSlug(slug: string): void {
  setStoredItem(STORAGE_KEY, slug);
}
