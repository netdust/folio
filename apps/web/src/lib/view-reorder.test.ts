import { describe, it, expect } from 'vitest';
import { reorderViewIds, spacedOrders } from './view-reorder.ts';

describe('reorderViewIds', () => {
  it('moves active down past over (adjacent)', () => {
    expect(reorderViewIds(['a', 'b', 'c'], 'a', 'b')).toEqual(['b', 'a', 'c']);
  });
  it('moves active up several slots at once', () => {
    expect(reorderViewIds(['a', 'b', 'c', 'd'], 'd', 'a')).toEqual(['d', 'a', 'b', 'c']);
  });
  it('no-op when active === over', () => {
    expect(reorderViewIds(['a', 'b'], 'a', 'a')).toEqual(['a', 'b']);
  });
  it('no-op when an id is absent', () => {
    expect(reorderViewIds(['a', 'b'], 'x', 'a')).toEqual(['a', 'b']);
  });
});

describe('spacedOrders', () => {
  it('assigns 0,10,20 by position', () => {
    expect(spacedOrders(['a', 'b', 'c'])).toEqual([
      { id: 'a', order: 0 },
      { id: 'b', order: 10 },
      { id: 'c', order: 20 },
    ]);
  });
});
