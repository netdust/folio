import { describe, expect, test } from 'vitest';
import { computeReorderPosition } from './board-reorder.ts';

// orderedPositions = the board_position values of the cards currently in the
// target column, in display order (null allowed for unranked). targetIndex =
// the slot the card is dropped into. Returns the new board_position string.
describe('computeReorderPosition', () => {
  test('drop between two ranked cards yields a position strictly between them', () => {
    const pos = computeReorderPosition(['a', 'c'], 1); // between a and c
    expect('a' < pos && pos < 'c').toBe(true);
  });
  test('drop at the start (index 0) yields a position before the first', () => {
    const pos = computeReorderPosition(['b', 'c'], 0);
    expect(pos < 'b').toBe(true);
  });
  test('drop at the end yields a position after the last', () => {
    const pos = computeReorderPosition(['a', 'b'], 2);
    expect(pos > 'b').toBe(true);
  });
  test('empty column yields a valid non-empty position', () => {
    const pos = computeReorderPosition([], 0);
    expect(typeof pos).toBe('string');
    expect(pos.length).toBeGreaterThan(0);
  });
  test('all-null neighbors yield a valid position', () => {
    const pos = computeReorderPosition([null, null], 1);
    expect(typeof pos).toBe('string');
  });

  // Regression (the first-column jump-back, 2026-06-18): a column had a ranked
  // card "V" then an UNRANKED card (null, sorts last). Dropping after the null
  // computed rankBetween(null, null) = "V" — a TIE with the ranked card → the
  // server's ORDER BY couldn't disambiguate → card "jumped over the first spot"
  // and re-dragging recomputed the same "V" → stuck. The immediate neighbor must
  // be SKIPPED to the nearest RANKED one, so this lands AFTER "V", not ON it.
  test('skips a null neighbor to the nearest RANKED one (no rank collision)', () => {
    const pos = computeReorderPosition(['V', null], 2); // drop after the null card
    expect(pos > 'V').toBe(true);
    expect(pos).not.toBe('V');
  });

  test('skips a leading null neighbor when dropping before a ranked card', () => {
    // [null, 'm'] is not a real display order, but the function must be robust:
    // dropping at index 1 (between null and 'm') ranks before 'm', skipping null.
    const pos = computeReorderPosition([null, 'm'], 1);
    expect(pos < 'm').toBe(true);
  });

  test('skips a null sandwiched between two ranked cards', () => {
    // ['c', null, 'm']; drop at index 2 (between the null and 'm') → must land
    // between 'c' and 'm' (skip the null up to 'c'), not rankBetween(null,'m').
    const pos = computeReorderPosition(['c', null, 'm'], 2);
    expect('c' < pos && pos < 'm').toBe(true);
  });
});
