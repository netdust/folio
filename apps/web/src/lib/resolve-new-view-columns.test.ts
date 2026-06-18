import { afterEach, describe, expect, it } from 'vitest';
import {
  clearColumnSnapshots,
  setColumnSnapshot,
} from '../components/table/current-columns-store.ts';
import { resolveNewViewColumns } from './resolve-new-view-columns.ts';

afterEach(() => clearColumnSnapshots());

describe('resolveNewViewColumns', () => {
  it('prefers the on-screen snapshot over the raw (null) saved view — THE BUG FIX', () => {
    setColumnSnapshot('acme', 'web', 'work-items', {
      visibleFields: ['title', 'status', 'priority'],
      columnOrder: ['title', 'status', 'priority'],
    });
    const out = resolveNewViewColumns({
      wslug: 'acme',
      pslug: 'web',
      tslug: 'work-items',
      activeView: { visibleFields: null, columnOrder: null }, // the default view's reality
    });
    expect(out).toEqual({
      visibleFields: ['title', 'status', 'priority'],
      columnOrder: ['title', 'status', 'priority'],
    });
  });

  it('falls back to the raw saved view when no snapshot exists for the table', () => {
    const out = resolveNewViewColumns({
      wslug: 'acme',
      pslug: 'web',
      tslug: 'bugs',
      activeView: { visibleFields: ['title', 'severity'], columnOrder: ['severity', 'title'] },
    });
    expect(out).toEqual({
      visibleFields: ['title', 'severity'],
      columnOrder: ['severity', 'title'],
    });
  });

  it('keeps snapshots isolated per tslug (bugs reads bugs, not work-items)', () => {
    setColumnSnapshot('acme', 'web', 'work-items', {
      visibleFields: ['title', 'status', 'updated_at'],
      columnOrder: ['title', 'status', 'updated_at'],
    });
    const out = resolveNewViewColumns({
      wslug: 'acme',
      pslug: 'web',
      tslug: 'bugs',
      activeView: { visibleFields: null, columnOrder: null },
    });
    // No snapshot for bugs → falls back to bugs' raw view (null), not work-items'.
    expect(out).toEqual({ visibleFields: null, columnOrder: null });
  });

  // ultrareview bug_005: the SAME tslug ('work-items') in a DIFFERENT project must
  // NOT inherit the other project's snapshot — it falls back to its own saved view.
  it('does NOT leak a same-named table snapshot across projects', () => {
    setColumnSnapshot('acme', 'web', 'work-items', {
      visibleFields: ['title', 'priority_web'],
      columnOrder: ['title', 'priority_web'],
    });
    const out = resolveNewViewColumns({
      wslug: 'acme',
      pslug: 'api', // different project, same tslug
      tslug: 'work-items',
      activeView: { visibleFields: null, columnOrder: null },
    });
    // No snapshot for acme/api/work-items → raw saved view (null), NOT web's columns.
    expect(out).toEqual({ visibleFields: null, columnOrder: null });
  });

  it('returns undefined when there is no active view and no snapshot', () => {
    expect(
      resolveNewViewColumns({ wslug: 'acme', pslug: 'web', tslug: 'work-items', activeView: null }),
    ).toBeUndefined();
  });
});
