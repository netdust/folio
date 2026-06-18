/**
 * A transient, module-level snapshot of the columns a table view is CURRENTLY
 * showing on screen. It exists to cross the render-sibling boundary between
 * TableView (in the route <Outlet/>) and the New-view sheet (in the <Rail/>) —
 * they have no common ancestor that holds both, so a plain prop/context lift is
 * unavailable without restructuring the route.
 *
 * Keyed by the FULL (wslug, pslug, tslug) triple, NOT tslug alone: tslug is
 * unique only within a project (DB unique index on projectId+slug), and
 * `work-items` is the seeded default tslug in EVERY project — so a tslug-only key
 * collides across projects/workspaces and a new view created in project B would
 * inherit project A's columns (ultrareview bug_005).
 *
 * This is UI state, NOT a source of truth (the saved view is) and NOT a
 * react-query cache (so invariant 6 does not govern it). TableView publishes its
 * resolved `visibleColumns` keys here; the New-view sheet reads them to seed a
 * created view as a copy of what the user is looking at. A read miss (table never
 * rendered this session) falls back to the raw saved-view read.
 */
export interface ColumnSnapshot {
  visibleFields: string[];
  columnOrder: string[];
}

const snapshots = new Map<string, ColumnSnapshot>();

function key(wslug: string, pslug: string, tslug: string): string {
  return `${wslug}/${pslug}/${tslug}`;
}

export function setColumnSnapshot(
  wslug: string,
  pslug: string,
  tslug: string,
  snapshot: ColumnSnapshot,
): void {
  snapshots.set(key(wslug, pslug, tslug), snapshot);
}

export function getColumnSnapshot(
  wslug: string,
  pslug: string,
  tslug: string,
): ColumnSnapshot | null {
  return snapshots.get(key(wslug, pslug, tslug)) ?? null;
}

/** Test-only: reset between cases (the Map is process-global). */
export function clearColumnSnapshots(): void {
  snapshots.clear();
}
