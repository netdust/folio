export type DropAction =
  | { kind: 'none' }
  | { kind: 'reorder' }
  | { kind: 'regroup' }
  | { kind: 'regroup-reorder' };

interface DropCtx {
  reorderEnabled: boolean;
  overIsColumn: boolean; // true if over.id was a col-* droppable
  activeGroupValue: string | null; // dragged card's current group value
  destColumnValue: string | null; // destination column's value
}

/**
 * Decide what a drag-end gesture means on the board, independent of dnd-kit.
 *
 * In MANUAL mode cards live inside per-column SortableContexts, so dropping on
 * a card reports the over-card's doc id rather than `col-*`. We therefore can't
 * infer intent from the droppable id alone — we compare the dragged card's
 * current group to the destination column. A card dropped on a card in another
 * column is a cross-column move (regroup + reorder), not a pure reorder.
 */
export function resolveDrop(ctx: DropCtx): DropAction {
  const sameGroup = ctx.activeGroupValue === ctx.destColumnValue;
  if (ctx.overIsColumn) {
    // whitespace drop: only meaningful if changing group
    return sameGroup ? { kind: 'none' } : { kind: 'regroup' };
  }
  // dropped on a card
  if (!ctx.reorderEnabled) return { kind: 'none' }; // sorted mode: card-over-card does nothing
  return sameGroup ? { kind: 'reorder' } : { kind: 'regroup-reorder' };
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
