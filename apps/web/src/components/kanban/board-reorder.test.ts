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
  test('null neighbors (unranked cards) are treated as open ends', () => {
    const pos = computeReorderPosition([null, null], 1);
    expect(typeof pos).toBe('string');
  });
});
