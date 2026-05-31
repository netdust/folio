import { rankBetween } from '@folio/shared';

/**
 * Compute the new board_position for a card dropped at `targetIndex` within a
 * column whose existing cards have positions `orderedPositions` (display order;
 * the dragged card already removed). Neighbors that are null (unranked) are
 * treated as open ends.
 */
export function computeReorderPosition(orderedPositions: (string | null)[], targetIndex: number): string {
  const lo = targetIndex > 0 ? orderedPositions[targetIndex - 1] ?? null : null;
  const hi = targetIndex < orderedPositions.length ? orderedPositions[targetIndex] ?? null : null;
  return rankBetween(lo, hi);
}
