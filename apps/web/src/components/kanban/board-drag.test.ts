import { describe, expect, test } from 'vitest';
import { resolveDrop, coerceGroupValue } from './board-drag.ts';

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
