import type { ViewType } from '@folio/shared';
import { DEFAULT_TABLE_SLUG } from './default-table.ts';

/** A rail-nav destination: the TanStack route id, and whether the navigate call
 *  must include a `tslug` param. Under the Phase 6 NocoDB/Option-B model EVERY
 *  table- and view-click lands on the unified `/t/$tslug` route (always with a
 *  `tslug` param) — the view TYPE is decided by <ViewRouter> from the saved
 *  view, not the URL. Legacy /work-items + /board are redirect-only. Branching
 *  wrong here sends a click on the `bugs` table to the wrong route — hence
 *  Tier A. */
export interface RailNavTarget {
  to: string;
  withTslug: boolean;
}

/** Where a TABLE-row click lands: ALWAYS the unified table route. Phase 6 routes
 *  the default table through `/t/$tslug` too (the `/work-items` redirect handles
 *  old bookmarks) so a table click and a view click on the same table land in
 *  the same place. */
export function resolveTableNav(_tslug: string): RailNavTarget {
  return { to: '/w/$wslug/p/$pslug/t/$tslug', withTslug: true };
}

/** Where a VIEW-row click lands: ALWAYS the unified table route. The view's TYPE
 *  is decided by <ViewRouter> from the saved view, not the URL (Option B,
 *  Phase 6). The caller carries `search: { view: id }`. Legacy /work-items +
 *  /board are redirect-only (back-compat). The `_type` param is retained for
 *  call-site compatibility but no longer branches the route. */
export function resolveViewNav(_tslug: string, _type: ViewType): RailNavTarget {
  return { to: '/w/$wslug/p/$pslug/t/$tslug', withTslug: true };
}

/** The table the layout is currently viewing, read off the URL path. A /t/<tslug>
 *  (or /t/<tslug>/board) path yields that tslug; the legacy /work-items + /board
 *  paths yield the default table; anything else (e.g. /wiki) yields undefined so
 *  the rail doesn't falsely highlight a table. */
export function activeTableFromPath(path: string): string | undefined {
  // Anchor the table segment AFTER `/p/<pslug>/` so a workspace or project
  // literally slugged `t` (`/w/t/...`, `/w/acme/p/t/...`) can't be mis-captured
  // as the table — the bare `/\/t\//` form matched the first `/t/` anywhere.
  const tMatch = path.match(/\/p\/[^/]+\/t\/([^/]+)/);
  if (tMatch) return tMatch[1];
  if (/\/(work-items|board)(\/|$)/.test(path)) return DEFAULT_TABLE_SLUG;
  return undefined;
}

/** Which project tab (grid 'work-items' vs 'board') is active for a path —
 *  table-route-aware. A /t/<tslug>/board path lights the Board tab; a bare
 *  /t/<tslug> (or /work-items) path lights the grid tab. Returns undefined for
 *  non-table paths (e.g. /wiki) so the caller can decide the default. */
export function activeTabFromPath(path: string): 'work-items' | 'board' | undefined {
  if (path.endsWith('/board')) return 'board';
  if (/\/t\/[^/]+\/?$/.test(path) || /\/work-items\/?$/.test(path)) return 'work-items';
  return undefined;
}
