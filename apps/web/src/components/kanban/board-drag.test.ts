import { describe, expect, test } from 'vitest';
import { resolveDrop, coerceGroupValue, dropSlotPosition } from './board-drag.ts';

describe('coerceGroupValue', () => {
  test('null stays null', () => {
    expect(coerceGroupValue(null, 'select')).toBeNull();
  });
  test('number field parses', () => {
    expect(coerceGroupValue('3', 'number')).toBe(3);
  });
  test('currency field parses', () => {
    expect(coerceGroupValue('4.5', 'currency')).toBe(4.5);
  });
  test('boolean field parses', () => {
    expect(coerceGroupValue('true', 'boolean')).toBe(true);
    expect(coerceGroupValue('false', 'boolean')).toBe(false);
  });
  test('non-numeric string in a number field falls back to the string', () => {
    expect(coerceGroupValue('abc', 'number')).toBe('abc');
  });
  test('select/text stays string', () => {
    expect(coerceGroupValue('High', 'select')).toBe('High');
  });
});

describe('resolveDrop', () => {
  // resolveDrop({ reorderEnabled, overIsColumn, activeGroupValue, destColumnValue }) → action
  test('sorted mode, drop on a card in the SAME column → auto-switch to manual + reorder', () => {
    // A within-column card-over-card drop while a sort is active = hand-reorder
    // intent the sort can't express. The view flips to Manual and applies the
    // board_position reorder (ISSUE 1 fix). Previously this returned {none}.
    expect(
      resolveDrop({ reorderEnabled: false, overIsColumn: false, activeGroupValue: 'a', destColumnValue: 'a' }).kind,
    ).toBe('auto-manual-reorder');
  });
  test('sorted mode, drop on a card in a DIFFERENT column → regroup (no reorder)', () => {
    // Cross-column card drop in sorted mode is a plain status/group change; the
    // destination order stays sort-derived, so no board_position is written.
    expect(
      resolveDrop({ reorderEnabled: false, overIsColumn: false, activeGroupValue: 'a', destColumnValue: 'b' }).kind,
    ).toBe('regroup');
  });
  test('manual mode, same column card drop → reorder only', () => {
    expect(
      resolveDrop({ reorderEnabled: true, overIsColumn: false, activeGroupValue: 'a', destColumnValue: 'a' }).kind,
    ).toBe('reorder');
  });
  test('manual mode, different column card drop → regroup + reorder', () => {
    const r = resolveDrop({ reorderEnabled: true, overIsColumn: false, activeGroupValue: 'a', destColumnValue: 'b' });
    expect(r.kind).toBe('regroup-reorder');
  });
  test('column whitespace drop, different group → regroup only', () => {
    expect(
      resolveDrop({ reorderEnabled: true, overIsColumn: true, activeGroupValue: 'a', destColumnValue: 'b' }).kind,
    ).toBe('regroup');
  });
  test('column whitespace drop, same group → no-op', () => {
    expect(
      resolveDrop({ reorderEnabled: false, overIsColumn: true, activeGroupValue: 'a', destColumnValue: 'a' }).kind,
    ).toBe('none');
  });
});

// dropSlotPosition is the reorder-ranking seam KanbanView calls on a
// within-column drop. The active card is excluded from the neighbor positions.
// The slot is DIRECTION-AWARE: dropping on the over-card lands ABOVE it when
// moving up (drop-before) and BELOW it when moving down (drop-after). Without
// the drop-after on a downward move, a down-by-one drop lands in the card's own
// slot and "never moves" (only worked when moving 2+ positions).
describe('dropSlotPosition', () => {
  const positions: Record<string, string | null> = { x: 'a', y: 'c', z: 'e' };
  const posOf = (id: string) => positions[id] ?? null;

  test('down-by-one: dragging a card onto the NEXT card lands it AFTER that card', () => {
    // Display order x(a) y(c) z(e); drag x DOWN onto y → x must land between
    // y(c) and z(e) (after y), NOT back above y. This is the regression: the old
    // drop-before put x before y = its own slot = no move.
    const pos = dropSlotPosition(['x', 'y', 'z'], posOf, 'x', 'y');
    expect('c' < pos && pos < 'e').toBe(true);
  });

  test('down onto the LAST card appends after it', () => {
    // Drag x DOWN onto z (the last card) → land after z(e).
    const pos = dropSlotPosition(['x', 'y', 'z'], posOf, 'x', 'z');
    expect(pos > 'e').toBe(true);
  });

  test('up: dragging a card onto an earlier card lands it BEFORE that card', () => {
    // Drag z UP onto y → land between x(a) and y(c) (above y, drop-before).
    const pos = dropSlotPosition(['x', 'y', 'z'], posOf, 'z', 'y');
    expect('a' < pos && pos < 'c').toBe(true);
  });

  test('up onto the FIRST card yields a rank before it', () => {
    const pos = dropSlotPosition(['x', 'y', 'z'], posOf, 'z', 'x');
    expect(pos < 'a').toBe(true);
  });

  test('null overDocId appends after the last remaining card', () => {
    const pos = dropSlotPosition(['x', 'y', 'z'], posOf, 'x', null);
    expect(pos > 'e').toBe(true);
  });

  test('an unranked (null board_position) neighbor is treated as an open end', () => {
    const pos = dropSlotPosition(['x', 'y'], (id) => (id === 'x' ? null : 'm'), 'y', 'x');
    expect(typeof pos).toBe('string');
    expect(pos.length).toBeGreaterThan(0);
  });
});
