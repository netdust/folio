/** Move `activeId` to the slot of `overId` (insert at over's position, like dnd-kit's
 *  arrayMove on the displayed order). Returns the new id order. No-op if either id is
 *  absent or they're equal. Pure — the single source of reorder truth. */
export function reorderViewIds(ids: string[], activeId: string, overId: string): string[] {
  if (activeId === overId) return ids;
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from === -1 || to === -1) return ids;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, activeId);
  return next;
}

/** Assign gap-spaced (0,10,20,…) orders by position. Reassigning ALL views on every
 *  reorder normalizes any drifted/colliding `order` values as a side effect. */
export function spacedOrders(ids: string[]): Array<{ id: string; order: number }> {
  return ids.map((id, i) => ({ id, order: i * 10 }));
}
