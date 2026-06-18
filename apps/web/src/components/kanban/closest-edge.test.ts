import { describe, expect, it } from 'vitest';
import { getClosestEdge } from './closest-edge.ts';

// over-card spans y=100..140 → midpoint 120.
const over = { top: 100, height: 40 };

describe('getClosestEdge', () => {
  it('returns "top" when the dragged-card center is above the over-card midpoint', () => {
    expect(getClosestEdge(105, over)).toBe('top');
    expect(getClosestEdge(119, over)).toBe('top');
  });

  it('returns "bottom" when the center is below the midpoint', () => {
    expect(getClosestEdge(121, over)).toBe('bottom');
    expect(getClosestEdge(140, over)).toBe('bottom');
  });

  it('treats exactly-at-midpoint as "bottom" (documented tie-break = at-or-below)', () => {
    expect(getClosestEdge(120, over)).toBe('bottom');
  });
});
