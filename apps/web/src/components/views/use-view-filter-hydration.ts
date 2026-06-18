import { useEffect, useRef } from 'react';
import type { View } from '../../lib/api/views.ts';

/** The filter keys hydrated from a saved view's `filters` into the URL search. */
const FILTER_KEYS = ['status', 'priority', 'assignee', 'labels', 'updated_since'] as const;

/**
 * One-level structural equality for URL search values. `===` is wrong here:
 * filter arrays (status/labels) are fresh references each render even when their
 * contents match, which would force `same` to false on every hydration pass.
 */
export function sameSearchValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }
  return false;
}

/** A minimal `navigate` signature — the subset of TanStack Router's API used here. */
type NavigateFn = (opts: {
  to: string;
  search: Record<string, unknown>;
  replace?: boolean;
}) => unknown;

/**
 * Hydrate the URL filters + sort from the ACTIVE view, once per view. Extracted
 * VERBATIM from the table-view effect so EVERY view type (not just table/list)
 * loads its saved filter on switch through one source of truth.
 *
 * The ref guard prevents re-firing when `search` updates as a RESULT of the
 * hydration navigate. A user's explicit URL filter always wins over the view's
 * stored value (deep-link override); the stored value only fills missing keys.
 * Switching the active view re-fires once for the new view's saved filter.
 */
export function useViewFilterHydration(
  activeView: View | null | undefined,
  search: Record<string, unknown>,
  navigate: NavigateFn,
  urlViewId: string | undefined,
): void {
  const hydratedViewId = useRef<string | null>(null);
  useEffect(() => {
    if (!activeView) return;
    if (hydratedViewId.current === activeView.id) return;
    hydratedViewId.current = activeView.id;

    const viewFilters = (activeView.filters ?? {}) as Record<string, unknown>;
    const nextSearch: Record<string, unknown> = {};

    if (search.doc) nextSearch.doc = search.doc;
    if (urlViewId) nextSearch.view = urlViewId;

    // URL filter params win — a user who deep-links with ?view=v1&status=todo
    // explicitly chose that override; the view's stored value only fills
    // missing keys.
    for (const key of FILTER_KEYS) {
      const urlValue = search[key];
      if (urlValue !== undefined && urlValue !== null && urlValue !== '') {
        nextSearch[key] = urlValue;
      }
    }

    // The compiler accepts both flat (`{status: 'In Progress'}`) and AST
    // (`{status: {$eq: 'In Progress'}}`); honor both at read time.
    for (const key of FILTER_KEYS) {
      if (key in nextSearch) continue; // URL already supplied this key.
      const raw = viewFilters[key];
      if (raw === undefined || raw === null || raw === '') continue;
      if (typeof raw === 'string' || typeof raw === 'number' || Array.isArray(raw)) {
        nextSearch[key] = raw;
        continue;
      }
      if (typeof raw === 'object') {
        const op = raw as Record<string, unknown>;
        if ('$eq' in op && op.$eq !== undefined) nextSearch[key] = op.$eq;
        else if ('$in' in op && Array.isArray(op.$in)) nextSearch[key] = op.$in as unknown[];
      }
    }

    // Sort: URL wins for the same reason.
    const urlSort = search.sort;
    if (typeof urlSort === 'string' && urlSort) {
      nextSearch.sort = urlSort;
      const urlDir = search.dir;
      nextSearch.dir = urlDir === 'desc' ? 'desc' : 'asc';
    } else {
      const viewSort = activeView.sort;
      if (Array.isArray(viewSort) && viewSort.length > 0) {
        const first = viewSort[0];
        if (first && typeof first === 'object' && 'key' in first) {
          const k = (first as { key: unknown }).key;
          if (typeof k === 'string') {
            nextSearch.sort = k;
            const d = (first as { dir?: unknown }).dir;
            nextSearch.dir = d === 'desc' ? 'desc' : 'asc';
          }
        }
      }
    }

    const same =
      Object.keys(search).length === Object.keys(nextSearch).length &&
      Object.keys(nextSearch).every((k) => sameSearchValue(nextSearch[k], search[k]));
    if (same) return;

    void navigate({ to: '.', search: nextSearch, replace: true });
  }, [activeView, urlViewId, navigate, search]);
}
