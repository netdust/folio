import { describe, expect, it } from 'vitest';
import {
  activeTabFromPath,
  activeTableFromPath,
  resolveTableNav,
  resolveViewNav,
} from './rail-nav.ts';

// Tier A: a wrong branch here sends a click on the `bugs` table to the wrong
// table/route (cross-table mis-navigation). Phase 6 Option-B behavior change:
// the view TYPE lives on the saved view (resolved by <ViewRouter>), NOT the URL,
// so EVERY table-click and view-click lands on the unified `/t/$tslug` route
// WITH params.tslug. The default table no longer special-cases to legacy
// `/work-items` + `/board`; those are redirect-only (Task 1.3).
describe('resolveTableNav — table-click destination', () => {
  // Phase 6: default table now routes through the unified `/t/$tslug` too
  // (the `/work-items` redirect handles old bookmarks). A table click and a
  // view click on the same table must land the SAME place.
  it('default table → unified /t/$tslug WITH a tslug param', () => {
    expect(resolveTableNav('work-items')).toEqual({
      to: '/w/$wslug/p/$pslug/t/$tslug',
      withTslug: true,
    });
  });

  it('non-default table → /t/$tslug WITH a tslug param', () => {
    expect(resolveTableNav('bugs')).toEqual({
      to: '/w/$wslug/p/$pslug/t/$tslug',
      withTslug: true,
    });
  });
});

describe('resolveViewNav — view-click destination is the unified route for every type', () => {
  // Phase 6 Option-B: the default table is no longer special-cased — a view
  // click on it lands on the unified `/t/$tslug`, NOT legacy `/work-items`.
  it('default table + calendar → unified /t/$tslug WITH tslug param', () => {
    expect(resolveViewNav('work-items', 'calendar')).toEqual({
      to: '/w/$wslug/p/$pslug/t/$tslug',
      withTslug: true,
    });
  });

  // Phase 6 Option-B: kanban no longer routes to `/board`; <ViewRouter> picks
  // the renderer from the saved view's type.
  it('non-default table + kanban → unified /t/$tslug WITH tslug param', () => {
    expect(resolveViewNav('bugs', 'kanban')).toEqual({
      to: '/w/$wslug/p/$pslug/t/$tslug',
      withTslug: true,
    });
  });

  // Behavioral-change denial assertion: the OLD default-table + kanban → /board
  // branch is GONE. This pair must resolve to the unified route, NOT /board.
  it('default table + kanban → unified /t/$tslug (the old default+kanban→/board branch is GONE)', () => {
    expect(resolveViewNav('work-items', 'kanban')).toEqual({
      to: '/w/$wslug/p/$pslug/t/$tslug',
      withTslug: true,
    });
  });

  it('non-default table + list → unified /t/$tslug WITH tslug param', () => {
    expect(resolveViewNav('bugs', 'list')).toEqual({
      to: '/w/$wslug/p/$pslug/t/$tslug',
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

  // The `/t/<tslug>` segment is anchored AFTER `/p/<pslug>/`. A workspace or
  // project literally slugged `t` must NOT be mistaken for a table segment —
  // the match would otherwise capture the wrong path segment and highlight a
  // non-existent table (or hide the real default one).
  it('a workspace slugged `t` → the default table (NOT `t`-as-table)', () => {
    expect(activeTableFromPath('/w/t/p/sales/work-items')).toBe('work-items');
  });

  it('a project slugged `t` → the default table (NOT `t`-as-table)', () => {
    expect(activeTableFromPath('/w/acme/p/t/work-items')).toBe('work-items');
  });

  it('a real /t/<tslug> under a project still resolves the table', () => {
    expect(activeTableFromPath('/w/acme/p/sales/t/bugs')).toBe('bugs');
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
