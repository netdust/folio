const STORAGE_KEY = 'folio:last-workspace-slug';

// Remembers the workspace the user was last in, so the root landing route can
// reopen it instead of dumping the user on the all-workspaces grid. Guarded for
// environments without localStorage (tests, SSR) — every accessor no-ops there.

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Accessing localStorage can throw (privacy mode, sandboxed iframe).
    return null;
  }
}

export function getLastWorkspaceSlug(): string | null {
  return safeStorage()?.getItem(STORAGE_KEY) ?? null;
}

export function setLastWorkspaceSlug(slug: string): void {
  safeStorage()?.setItem(STORAGE_KEY, slug);
}
