import { afterEach, describe, expect, it } from 'vitest';
import {
  type ColumnSnapshot,
  clearColumnSnapshots,
  getColumnSnapshot,
  setColumnSnapshot,
} from './current-columns-store.ts';

afterEach(() => clearColumnSnapshots());

describe('current-columns-store', () => {
  it('returns null for an unknown table (drives the raw-view fallback)', () => {
    expect(getColumnSnapshot('acme', 'web', 'work-items')).toBeNull();
  });

  it('round-trips a snapshot keyed by (wslug, pslug, tslug)', () => {
    const snap: ColumnSnapshot = {
      visibleFields: ['title', 'status', 'priority'],
      columnOrder: ['title', 'priority', 'status'],
    };
    setColumnSnapshot('acme', 'web', 'work-items', snap);
    expect(getColumnSnapshot('acme', 'web', 'work-items')).toEqual(snap);
  });

  it('overwrites a prior snapshot for the same table', () => {
    setColumnSnapshot('acme', 'web', 'work-items', {
      visibleFields: ['title'],
      columnOrder: ['title'],
    });
    setColumnSnapshot('acme', 'web', 'work-items', {
      visibleFields: ['title', 'status'],
      columnOrder: ['title', 'status'],
    });
    expect(getColumnSnapshot('acme', 'web', 'work-items')?.visibleFields).toEqual([
      'title',
      'status',
    ]);
  });

  it('keeps per-tslug snapshots isolated within a project', () => {
    setColumnSnapshot('acme', 'web', 'work-items', {
      visibleFields: ['title'],
      columnOrder: ['title'],
    });
    setColumnSnapshot('acme', 'web', 'bugs', {
      visibleFields: ['title', 'severity'],
      columnOrder: ['title', 'severity'],
    });
    expect(getColumnSnapshot('acme', 'web', 'work-items')?.visibleFields).toEqual(['title']);
    expect(getColumnSnapshot('acme', 'web', 'bugs')?.visibleFields).toEqual(['title', 'severity']);
  });

  // ultrareview bug_005: `work-items` is the seeded default tslug in EVERY project.
  // A tslug-only key collided across projects → a new view in project B inherited
  // project A's columns. The (wslug,pslug,tslug) key must isolate same-named tables
  // in different projects AND different workspaces.
  it('isolates the SAME tslug across different projects (no cross-project leak)', () => {
    setColumnSnapshot('acme', 'web', 'work-items', {
      visibleFields: ['title', 'priority_p1'],
      columnOrder: ['title', 'priority_p1'],
    });
    // Same tslug, different project → must NOT read p1's snapshot.
    expect(getColumnSnapshot('acme', 'api', 'work-items')).toBeNull();
    // Same tslug+project, different workspace → also isolated.
    expect(getColumnSnapshot('beta', 'web', 'work-items')).toBeNull();
    // The original entry is intact.
    expect(getColumnSnapshot('acme', 'web', 'work-items')?.visibleFields).toEqual([
      'title',
      'priority_p1',
    ]);
  });
});
