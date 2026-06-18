import { describe, expect, test } from 'vitest';
import {
  coerceGroupValue,
  dropSlotPosition,
  reorderSlotPosition,
  resolveDrop,
} from './board-drag.ts';

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
// reorderSlotPosition mirrors dnd-kit's OWN sortable order (arrayMove on the
// column id array) so the committed slot == the slot dnd-kit was SHOWING via the
// gap — no midpoint over-travel threshold. Used for SAME-column reorder.
describe('reorderSlotPosition (dnd-kit order)', () => {
  const positions: Record<string, string | null> = { x: 'a', y: 'c', z: 'e' };
  const posOf = (id: string) => positions[id] ?? null;

  test('drag x DOWN onto y → lands between y and z (the order arrayMove yields)', () => {
    // items x,y,z; move x to y's index → y,x,z → x is between y(c) and z(e).
    const pos = reorderSlotPosition(['x', 'y', 'z'], posOf, 'x', 'y');
    expect('c' < pos && pos < 'e').toBe(true);
  });

  test('drag x DOWN onto the LAST card z → appends after z', () => {
    // move x to z's index → y,z,x → x after z(e).
    const pos = reorderSlotPosition(['x', 'y', 'z'], posOf, 'x', 'z');
    expect(pos > 'e').toBe(true);
  });

  test('drag z UP onto x → lands before x (rank < a)', () => {
    // move z to x's index → z,x,y → z before x(a).
    const pos = reorderSlotPosition(['x', 'y', 'z'], posOf, 'z', 'x');
    expect(pos < 'a').toBe(true);
  });

  test('drag z UP onto y → lands between x and y', () => {
    // move z to y's index → x,z,y → z between x(a) and y(c).
    const pos = reorderSlotPosition(['x', 'y', 'z'], posOf, 'z', 'y');
    expect('a' < pos && pos < 'c').toBe(true);
  });

  test('drop on own slot (over === active) is a stable no-op rank', () => {
    // move x onto x → unchanged order x,y,z → x stays between (start) and y(c).
    const pos = reorderSlotPosition(['x', 'y', 'z'], posOf, 'x', 'x');
    expect(pos < 'c').toBe(true);
  });

  // Null board_position = UNRANKED (server sorts it LAST). Ranking relative to an
  // unranked neighbor must SKIP it to the nearest RANKED neighbor in the moved
  // order — else rankBetween treats null as an open end and the card sorts wrong
  // ("1 card in the column, dropped card jumps over the first spot, then stuck").
  // CRITICAL regression (ultrareview merged_bug_001): the dropped card's rank must
  // NOT COLLIDE with an existing ranked card. rankBetween(null,null) deterministically
  // returns 'V' (the first rank ever assigned), so ranking against null neighbors when
  // a ranked card already holds 'V' produced a TIE → server can't order → jump-back/stuck.
  test('ranked card dropped past a single UNRANKED card does NOT collide ranks (the jump-back)', () => {
    // r('V') first (the very first rank), u(null) last. Drag r DOWN onto u → r must
    // get a rank that is NOT 'V' and sorts relative to u correctly. The old code
    // returned rankBetween(null,null)='V' === r's own rank → no-op.
    const pos = reorderSlotPosition(['r', 'u'], (id) => (id === 'r' ? 'V' : null), 'r', 'u');
    expect(pos).not.toBe('V'); // no collision with the existing ranked card
  });

  test('drag the UNRANKED card ABOVE the ranked card → it ranks BEFORE the ranked one', () => {
    const pos = reorderSlotPosition(['r', 'u'], (id) => (id === 'r' ? 'm' : null), 'u', 'r');
    expect(pos < 'm').toBe(true);
  });

  test('skips an UNRANKED immediate neighbor to the nearest RANKED one (sorts between them)', () => {
    // Display a('c'), u(null), b('m'); drag x('a') onto b → lands between u and b.
    // lo must SKIP u(null) up to a('c'); hi = b('m'). Result sorts strictly between.
    const positions: Record<string, string | null> = { a: 'c', u: null, b: 'm', x: 'a' };
    const pos = reorderSlotPosition(['a', 'u', 'b', 'x'], (id) => positions[id] ?? null, 'x', 'b');
    expect('c' < pos && pos < 'm').toBe(true);
  });

  // Manifestation 2: an ALL-NULL column (no card ever ranked — e.g. first manual
  // reorder on a freshly-sorted board). Every reorderSlotPosition call returned
  // 'V' regardless of slot → the dropped card always sorted FIRST (siblings stay
  // null = last). The dropped card must rank to reflect its DROP SLOT among the
  // (still-unranked) siblings: dropping LAST must rank AFTER dropping FIRST.
  test('all-null column: dropping LAST ranks higher than dropping FIRST (slot is honored)', () => {
    const allNull = () => null;
    // Drop apple at the END (onto cherry): apple should sort after a front drop.
    const last = reorderSlotPosition(['apple', 'banana', 'cherry'], allNull, 'apple', 'cherry');
    // Drop cherry at the FRONT (onto apple).
    const first = reorderSlotPosition(['apple', 'banana', 'cherry'], allNull, 'cherry', 'apple');
    expect(last > first).toBe(true);
  });
});

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
