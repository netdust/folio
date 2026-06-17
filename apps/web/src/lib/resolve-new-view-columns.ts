import { getColumnSnapshot } from '../components/table/current-columns-store.ts';

interface ActiveViewColumns {
  visibleFields: string[] | null;
  columnOrder: string[] | null;
}

/**
 * Resolve the columns a NEW view should inherit: the columns the source table
 * is CURRENTLY showing on screen. Prefers the live on-screen snapshot (which
 * TableView publishes) — this is the bug fix: the default view's saved
 * `visibleFields` is almost always null, so the raw read seeded nothing and the
 * server fell back to the 3 builtins. The snapshot carries the real on-screen
 * set (builtins + visible field columns + order).
 *
 * Falls back to the raw saved-view columns when the table wasn't rendered this
 * session (no snapshot) — e.g. creating a view from a rail row for a table not
 * on screen. Returns undefined when there's nothing to inherit at all.
 */
export function resolveNewViewColumns(args: {
  tslug: string;
  activeView: ActiveViewColumns | null;
}): { visibleFields: string[] | null; columnOrder: string[] | null } | undefined {
  const snapshot = getColumnSnapshot(args.tslug);
  if (snapshot) {
    return { visibleFields: snapshot.visibleFields, columnOrder: snapshot.columnOrder };
  }
  if (!args.activeView) return undefined;
  return {
    visibleFields: args.activeView.visibleFields,
    columnOrder: args.activeView.columnOrder,
  };
}
