import { describe, expect, test } from 'vitest';
import { coerceGroupValue, dropSlotPosition, resolveDrop } from './board-drag.ts';

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
      resolveDrop({
        reorderEnabled: false,
        overIsColumn: false,
        activeGroupValue: 'a',
        destColumnValue: 'a',
      }).kind,
    ).toBe('auto-manual-reorder');
  });
  test('sorted mode, drop on a card in a DIFFERENT column → regroup (no reorder)', () => {
    // Cross-column card drop in sorted mode is a plain status/group change; the
    // destination order stays sort-derived, so no board_position is written.
    expect(
      resolveDrop({
        reorderEnabled: false,
        overIsColumn: false,
        activeGroupValue: 'a',
        destColumnValue: 'b',
      }).kind,
    ).toBe('regroup');
  });
  test('manual mode, same column card drop → reorder only', () => {
    expect(
      resolveDrop({
        reorderEnabled: true,
        overIsColumn: false,
        activeGroupValue: 'a',
        destColumnValue: 'a',
      }).kind,
    ).toBe('reorder');
  });
  test('manual mode, different column card drop → regroup + reorder', () => {
    const r = resolveDrop({
      reorderEnabled: true,
      overIsColumn: false,
      activeGroupValue: 'a',
      destColumnValue: 'b',
    });
    expect(r.kind).toBe('regroup-reorder');
  });
  test('column whitespace drop, different group → regroup only', () => {
    expect(
      resolveDrop({
        reorderEnabled: true,
        overIsColumn: true,
        activeGroupValue: 'a',
        destColumnValue: 'b',
      }).kind,
    ).toBe('regroup');
  });
  test('column whitespace drop, same group → no-op', () => {
    expect(
      resolveDrop({
        reorderEnabled: false,
        overIsColumn: true,
        activeGroupValue: 'a',
        destColumnValue: 'a',
      }).kind,
    ).toBe('none');
  });
});

// dropSlotPosition is the reorder-ranking seam KanbanView calls on a
// within-column drop. The active card is excluded from the neighbor positions.
// The slot is DIRECTION-AWARE: dropping on the over-card lands ABOVE it when
// moving up (drop-before) and BELOW it when moving down (drop-after). Without
// the drop-after on a downward move, a down-by-one drop lands in the card's own
// slot and "never moves" (only worked when moving 2+ positions).
// dropSlotPosition is now EDGE-AWARE: the caller passes the closest edge
// ('top' | 'bottom') computed from the dragged-card center vs the over-card
// midpoint (getClosestEdge), instead of the old array-index `movingDown`
// heuristic. The OUTCOMES below are unchanged from the index-heuristic era —
// only the input shape changed: each call now states the edge that reproduces
// the same intended drop. The edge a real drag produces is documented per case.
describe('dropSlotPosition (edge-aware)', () => {
  const positions: Record<string, string | null> = { x: 'a', y: 'c', z: 'e' };
  const posOf = (id: string) => positions[id] ?? null;

  test('down-by-one: drag x onto the BOTTOM half of the next card y → lands AFTER y', () => {
    // Display x(a) y(c) z(e); dragging x DOWN onto y, pointer in y's bottom half
    // → edge 'bottom' → x lands between y(c) and z(e). The regression: must NOT
    // land back above y (its own slot).
    const pos = dropSlotPosition(['x', 'y', 'z'], posOf, 'x', 'y', 'bottom');
    expect('c' < pos && pos < 'e').toBe(true);
  });

  test('MANDATORY: drop on the BOTTOM half of the LAST card → true append (the "lands second" bug)', () => {
    // Drag x DOWN onto z (last card), bottom half → must append AFTER z(e), not
    // land mid-list. This is the literal Stefan bug.
    const pos = dropSlotPosition(['x', 'y', 'z'], posOf, 'x', 'z', 'bottom');
    expect(pos > 'e').toBe(true);
  });

  test('up: drag z onto the TOP half of an earlier card y → lands BEFORE y', () => {
    // Drag z UP onto y, top half → edge 'top' → land between x(a) and y(c).
    const pos = dropSlotPosition(['x', 'y', 'z'], posOf, 'z', 'y', 'top');
    expect('a' < pos && pos < 'c').toBe(true);
  });

  test('top half of the FIRST card yields a rank before it', () => {
    const pos = dropSlotPosition(['x', 'y', 'z'], posOf, 'z', 'x', 'top');
    expect(pos < 'a').toBe(true);
  });

  test('cross-column drop on the BOTTOM half of a card → lands after it', () => {
    // active 'q' is NOT in this column's ordered ids → cross-column. Bottom half
    // of y → land between y(c) and z(e).
    const pos = dropSlotPosition(['x', 'y', 'z'], posOf, 'q', 'y', 'bottom');
    expect('c' < pos && pos < 'e').toBe(true);
  });

  test('cross-column drop on the TOP half of a card → lands before it', () => {
    const pos = dropSlotPosition(['x', 'y', 'z'], posOf, 'q', 'y', 'top');
    expect('a' < pos && pos < 'c').toBe(true);
  });

  test('null overDocId appends after the last remaining card (edge irrelevant)', () => {
    const pos = dropSlotPosition(['x', 'y', 'z'], posOf, 'x', null, 'bottom');
    expect(pos > 'e').toBe(true);
  });

  test('an unranked (null board_position) neighbor is treated as an open end', () => {
    const pos = dropSlotPosition(['x', 'y'], (id) => (id === 'x' ? null : 'm'), 'y', 'x', 'top');
    expect(typeof pos).toBe('string');
    expect(pos.length).toBeGreaterThan(0);
  });
});
