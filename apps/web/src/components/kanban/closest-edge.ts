/**
 * The single midpoint primitive for kanban drop placement (the "closest edge"
 * pattern from Atlassian Pragmatic / react-beautiful-dnd). Given the dragged
 * card's live center-Y and the over-card's geometry, returns which EDGE of the
 * over-card the drop should attach to — the one fact dnd-kit's collision
 * (`closestCorners`) does NOT give you. Both the drop-index logic
 * (`dropSlotPosition`) and the live drop-line indicator consume this; it is the
 * sole place the midpoint comparison lives (no duplication).
 *
 * Pure: no dnd-kit import. The caller extracts `activeCenterY` from the drag
 * event's `active.rect.current.translated` and `overRect` from `over.rect`.
 */
export type CardEdge = 'top' | 'bottom';

export function getClosestEdge(
  activeCenterY: number,
  overRect: { top: number; height: number },
): CardEdge {
  const midpoint = overRect.top + overRect.height / 2;
  // Tie-break: exactly-at-midpoint counts as 'bottom' (at-or-below). Keeps the
  // boundary deterministic and biases an ambiguous hover toward "after".
  return activeCenterY < midpoint ? 'top' : 'bottom';
}
