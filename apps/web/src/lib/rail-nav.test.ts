import { describe, expect, it } from 'vitest';
import {
  activeTableFromPath,
  activeTabFromPath,
  resolveTableNav,
  resolveViewNav,
} from './rail-nav.ts';

// Tier A: a wrong branch here sends a click on the `bugs` table to the
// work-items table (cross-table mis-navigation). The default ('work-items')
// must resolve to the legacy `/work-items` + `/board` routes (no :tslug param);
// any other tslug must resolve to the `/t/$tslug` family WITH params.tslug.
describe('resolveTableNav — table-click destination', () => {
  it('default table → /work-items with NO tslug param', () => {
    expect(resolveTableNav('work-items')).toEqual({
      to: '/w/$wslug/p/$pslug/work-items',
      withTslug: false,
    });
  });

  it('non-default table → /t/$tslug WITH a tslug param', () => {
    expect(resolveTableNav('bugs')).toEqual({
      to: '/w/$wslug/p/$pslug/t/$tslug',
      withTslug: true,
    });
  });
});

describe('resolveViewNav — view-click destination by (tslug, type)', () => {
  it('default table + list → /work-items, no tslug param', () => {
    expect(resolveViewNav('work-items', 'list')).toEqual({
      to: '/w/$wslug/p/$pslug/work-items',
      withTslug: false,
    });
  });

  it('default table + kanban → /board, no tslug param', () => {
    expect(resolveViewNav('work-items', 'kanban')).toEqual({
      to: '/w/$wslug/p/$pslug/board',
      withTslug: false,
    });
  });

  it('non-default table + list → /t/$tslug WITH tslug param', () => {
    expect(resolveViewNav('bugs', 'list')).toEqual({
      to: '/w/$wslug/p/$pslug/t/$tslug',
      withTslug: true,
    });
  });

  it('non-default table + kanban → /t/$tslug/board WITH tslug param', () => {
    expect(resolveViewNav('bugs', 'kanban')).toEqual({
      to: '/w/$wslug/p/$pslug/t/$tslug/board',
      withTslug: true,
    });
  });
});

// Tier A: the tab-strip's active-tab + the table the BoardControls/tabs operate
// on are derived from the URL path. A board path under /t/<tslug> must light the
// Board tab (not fall through to the work-items default), and the active tslug
// must be the real one (so BoardControls writes group-by/sort to that table).
describe('activeTableFromPath — which table is the layout viewing', () => {
  it('a /work-items path → the default table', () => {
    expect(activeTableFromPath('/w/acme/p/sales/work-items')).toBe('work-items');
  });

  it('a /board path → the default table', () => {
    expect(activeTableFromPath('/w/acme/p/sales/board')).toBe('work-items');
  });

  it('a /t/<tslug> path → that table', () => {
    expect(activeTableFromPath('/w/acme/p/sales/t/bugs')).toBe('bugs');
  });

  it('a /t/<tslug>/board path → that table', () => {
    expect(activeTableFromPath('/w/acme/p/sales/t/bugs/board')).toBe('bugs');
  });
});

describe('activeTabFromPath — grid vs board tab', () => {
  it('/work-items → grid tab', () => {
    expect(activeTabFromPath('/w/acme/p/sales/work-items')).toBe('work-items');
  });
  it('/board → board tab', () => {
    expect(activeTabFromPath('/w/acme/p/sales/board')).toBe('board');
  });
  it('/t/bugs → grid tab (not a fallthrough to work-items default)', () => {
    expect(activeTabFromPath('/w/acme/p/sales/t/bugs')).toBe('work-items');
  });
  it('/t/bugs/board → board tab', () => {
    expect(activeTabFromPath('/w/acme/p/sales/t/bugs/board')).toBe('board');
  });
});
