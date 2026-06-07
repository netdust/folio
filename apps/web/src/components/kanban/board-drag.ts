import { computeReorderPosition } from './board-reorder.ts';

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
 * Compute the board_position for dropping the active card into a column whose
 * current cards (active card already removed) have positions `orderedPositions`,
 * at the slot occupied by `overDocId` (drop-before). A `null` overDocId appends.
 * Pure mirror of KanbanView.dropSlotPosition so the reorder ranking is testable
 * without simulating a dnd-kit pointer drag.
 */
export function dropSlotPosition(
  orderedDocIds: string[],
  positionOf: (id: string) => string | null,
  activeId: string,
  overDocId: string | null,
): string {
  const idsWithoutActive = orderedDocIds.filter((id) => id !== activeId);
  const idx = overDocId === null ? idsWithoutActive.length : idsWithoutActive.indexOf(overDocId);
  const targetIndex = idx === -1 ? idsWithoutActive.length : idx;
  const positions = idsWithoutActive.map((id) => positionOf(id) ?? null);
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
