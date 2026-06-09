import { DEFAULT_TABLE_SLUG } from './default-table.ts';

/** A rail-nav destination: the TanStack route id, and whether the navigate call
 *  must include a `tslug` param. The default table uses the legacy
 *  /work-items + /board routes (no :tslug segment); every other table routes to
 *  the /t/$tslug family, which needs `params.tslug`. Branching wrong here sends
 *  a click on the `bugs` table to the work-items table — hence Tier A. */
export interface RailNavTarget {
  to: string;
  withTslug: boolean;
}

/** Where a TABLE-row click lands. Default → its work-items grid; otherwise the
 *  table's own grid under /t/$tslug. */
export function resolveTableNav(tslug: string): RailNavTarget {
  if (tslug === DEFAULT_TABLE_SLUG) {
    return { to: '/w/$wslug/p/$pslug/work-items', withTslug: false };
  }
  return { to: '/w/$wslug/p/$pslug/t/$tslug', withTslug: true };
}

/** Where a VIEW-row click lands, by the table it belongs to and the view type.
 *  Default table: list → /work-items, kanban → /board (legacy routes, no param).
 *  Non-default table: list → /t/$tslug, kanban → /t/$tslug/board (with param). */
export function resolveViewNav(tslug: string, type: 'list' | 'kanban'): RailNavTarget {
  if (tslug === DEFAULT_TABLE_SLUG) {
    return {
      to: type === 'kanban' ? '/w/$wslug/p/$pslug/board' : '/w/$wslug/p/$pslug/work-items',
      withTslug: false,
    };
  }
  return {
    to: type === 'kanban' ? '/w/$wslug/p/$pslug/t/$tslug/board' : '/w/$wslug/p/$pslug/t/$tslug',
    withTslug: true,
  };
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
