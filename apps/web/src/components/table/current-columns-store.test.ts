import { afterEach, describe, expect, it } from 'vitest';
import {
  type ColumnSnapshot,
  clearColumnSnapshots,
  getColumnSnapshot,
  setColumnSnapshot,
} from './current-columns-store.ts';

afterEach(() => clearColumnSnapshots());

describe('current-columns-store', () => {
  it('returns null for an unknown tslug (drives the raw-view fallback)', () => {
    expect(getColumnSnapshot('work-items')).toBeNull();
  });

  it('round-trips a snapshot keyed by tslug', () => {
    const snap: ColumnSnapshot = {
      visibleFields: ['title', 'status', 'priority'],
      columnOrder: ['title', 'priority', 'status'],
    };
    setColumnSnapshot('work-items', snap);
    expect(getColumnSnapshot('work-items')).toEqual(snap);
  });

  it('overwrites a prior snapshot for the same tslug', () => {
    setColumnSnapshot('work-items', { visibleFields: ['title'], columnOrder: ['title'] });
    setColumnSnapshot('work-items', {
      visibleFields: ['title', 'status'],
      columnOrder: ['title', 'status'],
    });
    expect(getColumnSnapshot('work-items')?.visibleFields).toEqual(['title', 'status']);
  });

  it('keeps per-tslug snapshots isolated', () => {
    setColumnSnapshot('work-items', { visibleFields: ['title'], columnOrder: ['title'] });
    setColumnSnapshot('bugs', {
      visibleFields: ['title', 'severity'],
      columnOrder: ['title', 'severity'],
    });
    expect(getColumnSnapshot('work-items')?.visibleFields).toEqual(['title']);
    expect(getColumnSnapshot('bugs')?.visibleFields).toEqual(['title', 'severity']);
  });
});
