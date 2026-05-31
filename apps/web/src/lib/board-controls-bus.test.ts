import { describe, expect, test, beforeEach } from 'vitest';
import { boardControlsBus } from './board-controls-bus.ts';

beforeEach(() => boardControlsBus.reset());

describe('boardControlsBus', () => {
  test('get returns undefined for an unknown view', () => {
    expect(boardControlsBus.get('v1')).toBeUndefined();
  });
  test('setGroupBy stores an override and notifies subscribers', () => {
    let notified = false;
    const off = boardControlsBus.subscribe(() => { notified = true; });
    boardControlsBus.setGroupBy('v1', 'assignee');
    expect(boardControlsBus.get('v1')).toEqual({ groupBy: 'assignee' });
    expect(notified).toBe(true);
    off();
  });
  test('setSort stores sort (null = manual) preserving groupBy', () => {
    boardControlsBus.setGroupBy('v1', 'assignee');
    boardControlsBus.setSort('v1', null);
    expect(boardControlsBus.get('v1')).toEqual({ groupBy: 'assignee', sort: null });
  });
  test('overrides are per view id', () => {
    boardControlsBus.setGroupBy('v1', 'assignee');
    expect(boardControlsBus.get('v2')).toBeUndefined();
  });
  test('reset clears all overrides', () => {
    boardControlsBus.setGroupBy('v1', 'assignee');
    boardControlsBus.reset();
    expect(boardControlsBus.get('v1')).toBeUndefined();
  });
});
