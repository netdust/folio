import { rankBetween } from '@folio/shared';

/**
 * Compute the new board_position for a card dropped at `targetIndex` within a
 * column whose existing cards have positions `orderedPositions` (display order;
 * the dragged card already removed). Neighbors that are null (unranked) are
 * treated as open ends.
 */
export function computeReorderPosition(
  orderedPositions: (string | null)[],
  targetIndex: number,
): string {
  // Skip UNRANKED (null) neighbors to the nearest RANKED card on each side.
  // An unranked card has board_position=null → the server sorts it LAST (sentinel),
  // so it is NOT a meaningful rank boundary. Using it directly made the drop
  // compute rankBetween(null, …) and collide with an existing rank (the
  // first-column jump-back, 2026-06-18). Scanning to the nearest ranked neighbor
  // ranks the dropped card among the actually-ranked cards; unranked cards keep
  // their null until dragged themselves (still sorting last, order preserved).
  let lo: string | null = null;
  for (let i = targetIndex - 1; i >= 0; i--) {
    const p = orderedPositions[i];
    if (p != null) {
      lo = p;
      break;
    }
  }
  let hi: string | null = null;
  for (let i = targetIndex; i < orderedPositions.length; i++) {
    const p = orderedPositions[i];
    if (p != null) {
      hi = p;
      break;
    }
  }
  return rankBetween(lo, hi);
}
