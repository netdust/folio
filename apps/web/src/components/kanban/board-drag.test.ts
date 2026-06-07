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
  test('sorted mode, drop on a card → no-op (reorder disabled)', () => {
    expect(
      resolveDrop({ reorderEnabled: false, overIsColumn: false, activeGroupValue: 'a', destColumnValue: 'b' }).kind,
    ).toBe('none');
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

// 4c: dropSlotPosition is the reorder-ranking seam KanbanView calls on a
// within-column drop. The active card is excluded from the neighbor positions,
// and the slot is resolved by the over-card's id (drop-before; null = append).
describe('dropSlotPosition', () => {
  const positions: Record<string, string | null> = { x: 'a', y: 'c', z: 'e' };
  const posOf = (id: string) => positions[id] ?? null;

  test('dropping before a middle card yields a rank between its neighbors', () => {
    // Column display order x(a) y(c) z(e); drag x to land before z → between y(c) and z(e).
    const pos = dropSlotPosition(['x', 'y', 'z'], posOf, 'x', 'z');
    expect('c' < pos && pos < 'e').toBe(true);
  });

  test('null overDocId appends after the last remaining card', () => {
    // Drag x to the end (overDocId null) → after z(e).
    const pos = dropSlotPosition(['x', 'y', 'z'], posOf, 'x', null);
    expect(pos > 'e').toBe(true);
  });

  test('dropping before the first card yields a rank before it', () => {
    const pos = dropSlotPosition(['x', 'y', 'z'], posOf, 'z', 'x');
    expect(pos < 'a').toBe(true);
  });

  test('an unranked (null board_position) neighbor is treated as an open end', () => {
    const pos = dropSlotPosition(['x', 'y'], (id) => (id === 'x' ? null : 'm'), 'y', 'x');
    expect(typeof pos).toBe('string');
    expect(pos.length).toBeGreaterThan(0);
  });
});
