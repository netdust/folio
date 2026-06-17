import { afterEach, describe, expect, it } from 'vitest';
import {
  clearColumnSnapshots,
  setColumnSnapshot,
} from '../components/table/current-columns-store.ts';
import { resolveNewViewColumns } from './resolve-new-view-columns.ts';

afterEach(() => clearColumnSnapshots());

describe('resolveNewViewColumns', () => {
  it('prefers the on-screen snapshot over the raw (null) saved view — THE BUG FIX', () => {
    setColumnSnapshot('work-items', {
      visibleFields: ['title', 'status', 'priority'],
      columnOrder: ['title', 'status', 'priority'],
    });
    const out = resolveNewViewColumns({
      tslug: 'work-items',
      activeView: { visibleFields: null, columnOrder: null }, // the default view's reality
    });
    expect(out).toEqual({
      visibleFields: ['title', 'status', 'priority'],
      columnOrder: ['title', 'status', 'priority'],
    });
  });

  it('falls back to the raw saved view when no snapshot exists for the tslug', () => {
    const out = resolveNewViewColumns({
      tslug: 'bugs',
      activeView: { visibleFields: ['title', 'severity'], columnOrder: ['severity', 'title'] },
    });
    expect(out).toEqual({
      visibleFields: ['title', 'severity'],
      columnOrder: ['severity', 'title'],
    });
  });

  it('keeps snapshots isolated per tslug (bugs reads bugs, not work-items)', () => {
    setColumnSnapshot('work-items', {
      visibleFields: ['title', 'status', 'updated_at'],
      columnOrder: ['title', 'status', 'updated_at'],
    });
    const out = resolveNewViewColumns({
      tslug: 'bugs',
      activeView: { visibleFields: null, columnOrder: null },
    });
    // No snapshot for bugs → falls back to bugs' raw view (null), not work-items'.
    expect(out).toEqual({ visibleFields: null, columnOrder: null });
  });

  it('returns undefined when there is no active view and no snapshot', () => {
    expect(resolveNewViewColumns({ tslug: 'work-items', activeView: null })).toBeUndefined();
  });
});
