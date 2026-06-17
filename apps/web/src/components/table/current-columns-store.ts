/**
 * A transient, module-level snapshot of the columns a table view is CURRENTLY
 * showing on screen, keyed by tslug. It exists to cross the render-sibling
 * boundary between TableView (in the route <Outlet/>) and the New-view sheet
 * (in the <Rail/>) — they have no common ancestor that holds both, so a plain
 * prop/context lift is unavailable without restructuring the route.
 *
 * This is UI state, NOT a source of truth (the saved view is) and NOT a
 * react-query cache (so invariant 6 does not govern it). TableView publishes
 * its resolved `visibleColumns` keys here; the New-view sheet reads them to
 * seed a created view as a copy of what the user is looking at. A read miss
 * (table never rendered this session) falls back to the raw saved-view read.
 */
export interface ColumnSnapshot {
  visibleFields: string[];
  columnOrder: string[];
}

const snapshots = new Map<string, ColumnSnapshot>();

export function setColumnSnapshot(tslug: string, snapshot: ColumnSnapshot): void {
  snapshots.set(tslug, snapshot);
}

export function getColumnSnapshot(tslug: string): ColumnSnapshot | null {
  return snapshots.get(tslug) ?? null;
}

/** Test-only: reset between cases (the Map is process-global). */
export function clearColumnSnapshots(): void {
  snapshots.clear();
}
