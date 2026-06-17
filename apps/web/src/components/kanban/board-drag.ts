import { rankBetween } from '@folio/shared';
import { computeReorderPosition } from './board-reorder.ts';
import type { CardEdge } from './closest-edge.ts';

export type DropAction =
  | { kind: 'none' }
  | { kind: 'reorder' }
  | { kind: 'regroup' }
  | { kind: 'regroup-reorder' }
  // Sorted mode (reorderEnabled=false): the user dropped a card ON another card
  // in the SAME column — a hand-reorder intent the active sort can't express.
  // The view responds by switching Sort→Manual (bus + persist) AND applying the
  // board_position reorder, so the card lands where dropped.
  | { kind: 'auto-manual-reorder' };

interface DropCtx {
  reorderEnabled: boolean;
  overIsColumn: boolean; // true if over.id was a col-* droppable
  activeGroupValue: string | null; // dragged card's current group value
  destColumnValue: string | null; // destination column's value
}

/**
 * Decide what a drag-end gesture means on the board, independent of dnd-kit.
 *
 * Cards live inside per-column SortableContexts in BOTH modes (always sortable),
 * so dropping on a card reports the over-card's doc id rather than `col-*`. We
 * therefore can't infer intent from the droppable id alone — we compare the
 * dragged card's current group to the destination column. A card dropped on a
 * card in another column is a cross-column move (regroup), not a pure reorder.
 *
 * In SORTED mode (reorderEnabled=false) a same-column card-over-card drop is a
 * hand-reorder intent the active sort can't express → `auto-manual-reorder`:
 * the view flips Sort→Manual and applies the board_position reorder so the card
 * lands where dropped. A cross-column card drop in sorted mode is a plain
 * regroup (the destination order is still sort-derived, so no board_position).
 */
export function resolveDrop(ctx: DropCtx): DropAction {
  const sameGroup = ctx.activeGroupValue === ctx.destColumnValue;
  if (ctx.overIsColumn) {
    // whitespace drop: only meaningful if changing group
    return sameGroup ? { kind: 'none' } : { kind: 'regroup' };
  }
  // dropped on a card
  if (!ctx.reorderEnabled) {
    // sorted mode: same-column card drop = reorder intent → switch to manual;
    // cross-column card drop = regroup (order stays sort-derived).
    return sameGroup ? { kind: 'auto-manual-reorder' } : { kind: 'regroup' };
  }
  return sameGroup ? { kind: 'reorder' } : { kind: 'regroup-reorder' };
}

/**
 * SAME-column reorder. Mirrors dnd-kit's OWN sortable order: move the active id
 * to the over id's index (arrayMove) and rank the dropped card BETWEEN its
 * resulting neighbors. This makes the committed slot == the slot dnd-kit was
 * already SHOWING via the live gap — so "the gap opened" is enough; there is no
 * midpoint over-travel threshold to cross (the bug: cards only reordered if you
 * dragged well PAST the neighbor). For CROSS-column drops (no shared item array)
 * use `dropSlotPosition` with the pointer edge instead.
 *
 * `columnDocIds` is the column's FULL display order (active still in it).
 */
export function reorderSlotPosition(
  columnDocIds: string[],
  positionOf: (id: string) => string | null,
  activeId: string,
  overId: string,
): string {
  const from = columnDocIds.indexOf(activeId);
  const to = columnDocIds.indexOf(overId);
  if (from === -1 || to === -1) {
    // Defensive: fall back to appending if either id is missing from the column.
    const positions = columnDocIds.filter((id) => id !== activeId).map((id) => positionOf(id));
    return computeReorderPosition(positions, positions.length);
  }
  // arrayMove (inlined, pure): the resolved order dnd-kit renders.
  const moved = [...columnDocIds];
  moved.splice(to, 0, moved.splice(from, 1)[0] as string);
  // Rank the dropped card between its neighbors in the MOVED order.
  const landedIdx = moved.indexOf(activeId);
  const lo = landedIdx > 0 ? (positionOf(moved[landedIdx - 1] as string) ?? null) : null;
  const hi =
    landedIdx < moved.length - 1 ? (positionOf(moved[landedIdx + 1] as string) ?? null) : null;
  return rankBetween(lo, hi);
}

/**
 * Compute the board_position for dropping the active card into a column whose
 * current cards (active card already removed) have positions `orderedPositions`,
 * at the slot occupied by `overDocId` (drop-before). A `null` overDocId appends.
 * Pure mirror of KanbanView.dropSlotPosition so the reorder ranking is testable
 * without simulating a dnd-kit pointer drag. Used for CROSS-column drops (the
 * edge decides before/after the over-card).
 */
export function dropSlotPosition(
  orderedDocIds: string[],
  positionOf: (id: string) => string | null,
  activeId: string,
  overDocId: string | null,
  closestEdge: CardEdge,
): string {
  const idsWithoutActive = orderedDocIds.filter((id) => id !== activeId);
  const positions = idsWithoutActive.map((id) => positionOf(id) ?? null);

  // Append when dropping on column whitespace.
  if (overDocId === null) return computeReorderPosition(positions, idsWithoutActive.length);

  const overIdx = idsWithoutActive.indexOf(overDocId);
  if (overIdx === -1) return computeReorderPosition(positions, idsWithoutActive.length);

  // EDGE-AWARE drop slot (the "lands second" fix). computeReorderPosition inserts
  // BEFORE targetIndex into the active-REMOVED array, so `overIdx` is already the
  // over-card's post-removal position. The drop side comes from where the dragged
  // card's CENTER is relative to the over-card MIDPOINT (closestEdge), not from
  // an array-index direction guess:
  //   - edge 'top'    → land BEFORE the over-card → targetIndex = overIdx
  //   - edge 'bottom' → land AFTER  the over-card → targetIndex = overIdx + 1
  // The bottom half of the LAST card yields overIdx+1 === length → a true append
  // (the old index heuristic mis-fired here → the card "landed second"). This is
  // uniform for same-column and cross-column because overIdx is always measured
  // in the active-removed array.
  const targetIndex = closestEdge === 'bottom' ? overIdx + 1 : overIdx;
  return computeReorderPosition(positions, targetIndex);
}

/**
 * Board column values are always strings (buildColumns stringifies via
 * String(v)). When grouping by a typed field we must coerce that string back to
 * the field's type before writing it to frontmatter, or we flip the stored type
 * (e.g. number 3 → "3") and break numeric sort + type inference.
 */
export function coerceGroupValue(value: string | null, fieldType: string | undefined): unknown {
  if (value === null) return null;
  if (fieldType === 'number' || fieldType === 'currency') {
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
  if (fieldType === 'boolean') return value === 'true';
  return value;
}
