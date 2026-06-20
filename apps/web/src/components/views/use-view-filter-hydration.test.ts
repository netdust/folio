import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { View } from '../../lib/api/views.ts';
import { useViewFilterHydration } from './use-view-filter-hydration.ts';

// A minimal View factory — only the fields the hydration hook reads matter.
function view(overrides: Partial<View>): View {
  return {
    id: 'v1',
    name: 'A view',
    type: 'table',
    filters: {},
    sort: null,
    groupBy: null,
    visibleFields: null,
    columnOrder: null,
    settings: {},
    isDefault: true,
    order: 0,
    ...overrides,
  };
}

describe('useViewFilterHydration', () => {
  it("hydrates a view's saved flat filter into the URL search (status)", () => {
    const navigate = vi.fn();
    renderHook(() =>
      useViewFilterHydration(view({ filters: { status: ['todo'] } }), {}, navigate, undefined),
    );

    expect(navigate).toHaveBeenCalledTimes(1);
    const [arg] = navigate.mock.calls[0];
    expect(arg).toMatchObject({ to: '.', replace: true });
    expect((arg.search as Record<string, unknown>).status).toEqual(['todo']);
  });

  it("honors a view's $eq AST filter, mapping it to the flat URL value", () => {
    const navigate = vi.fn();
    renderHook(() =>
      useViewFilterHydration(
        view({ filters: { status: { $eq: 'In Progress' } } }),
        {},
        navigate,
        undefined,
      ),
    );

    const [arg] = navigate.mock.calls[0];
    expect((arg.search as Record<string, unknown>).status).toBe('In Progress');
  });

  it("hydrates a view's saved GENERIC field filter ($eq) into f_<key>", () => {
    const navigate = vi.fn();
    renderHook(() =>
      useViewFilterHydration(
        view({ filters: { role: { $eq: 'performer' } } }),
        {},
        navigate,
        undefined,
      ),
    );
    const [arg] = navigate.mock.calls[0];
    expect((arg.search as Record<string, unknown>).f_role).toBe('eq:s:performer');
  });

  it("hydrates a view's saved GENERIC field filter ($contains) into f_<key>=has:", () => {
    const navigate = vi.fn();
    renderHook(() =>
      useViewFilterHydration(
        view({ filters: { diet_tags: { $contains: ['veggie'] } } }),
        {},
        navigate,
        undefined,
      ),
    );
    const [arg] = navigate.mock.calls[0];
    expect((arg.search as Record<string, unknown>).f_diet_tags).toBe('has:s:veggie');
  });

  it('hydrates a saved BOOLEAN field filter with the bool type tag (drives=true reload)', () => {
    const navigate = vi.fn();
    renderHook(() =>
      useViewFilterHydration(view({ filters: { drives: { $eq: true } } }), {}, navigate, undefined),
    );
    const [arg] = navigate.mock.calls[0];
    expect((arg.search as Record<string, unknown>).f_drives).toBe('eq:b:true');
  });

  it('hydrates a saved NUMBER field filter with the number type tag', () => {
    const navigate = vi.fn();
    renderHook(() =>
      useViewFilterHydration(
        view({ filters: { headcount: { $eq: 12 } } }),
        {},
        navigate,
        undefined,
      ),
    );
    const [arg] = navigate.mock.calls[0];
    expect((arg.search as Record<string, unknown>).f_headcount).toBe('eq:n:12');
  });

  it("honors a view's $in AST filter as an array", () => {
    const navigate = vi.fn();
    renderHook(() =>
      useViewFilterHydration(
        view({ filters: { labels: { $in: ['bug', 'p1'] } } }),
        {},
        navigate,
        undefined,
      ),
    );

    const [arg] = navigate.mock.calls[0];
    expect((arg.search as Record<string, unknown>).labels).toEqual(['bug', 'p1']);
  });

  it('lets an explicit URL filter param win over the view-stored value (URL precedence)', () => {
    const navigate = vi.fn();
    // URL arrives with ?view=v1&status=todo; the view stores a DIFFERENT status
    // ("In Progress") AND a priority the URL lacks. The URL's status must win;
    // the view's priority fills the missing key — so a navigate DOES fire.
    renderHook(() =>
      useViewFilterHydration(
        view({ filters: { status: { $eq: 'In Progress' }, priority: { $eq: 'high' } } }),
        { status: 'todo', view: 'v1' },
        navigate,
        'v1',
      ),
    );

    expect(navigate).toHaveBeenCalledTimes(1);
    const [arg] = navigate.mock.calls[0];
    const search = arg.search as Record<string, unknown>;
    // URL's explicit status wins over the view's stored "In Progress".
    expect(search.status).toBe('todo');
    // The view's priority fills the key the URL didn't supply.
    expect(search.priority).toBe('high');
    expect(search.view).toBe('v1');
  });

  it("hydrates a view's saved sort (incl. a custom field key not in the URL enum)", () => {
    // I2-moved from table-view.test.tsx: a saved view can sort by any column key
    // (e.g. a custom field 'next_action_due'). The hook applies that sort intent
    // to the URL unchanged — proving the single hydration owner carries sort, not
    // just filters.
    const navigate = vi.fn();
    renderHook(() =>
      useViewFilterHydration(
        view({ filters: {}, sort: [{ key: 'next_action_due', dir: 'asc' }] }),
        {},
        navigate,
        undefined,
      ),
    );

    expect(navigate).toHaveBeenCalledTimes(1);
    const search = navigate.mock.calls[0][0].search as Record<string, unknown>;
    expect(search.sort).toBe('next_action_due');
    expect(search.dir).toBe('asc');
  });

  it('lets an explicit URL sort win over the view-stored sort', () => {
    // The denial/precedence path for sort: a user who deep-links ?sort=title must
    // keep it; the view's stored sort does not clobber the explicit URL choice.
    // A view-only filter (status) is added so the hydration navigate DOES fire —
    // then we assert the resulting sort is the URL's, not the view's.
    const navigate = vi.fn();
    renderHook(() =>
      useViewFilterHydration(
        view({
          filters: { status: ['todo'] },
          sort: [{ key: 'next_action_due', dir: 'asc' }],
        }),
        { sort: 'title', dir: 'desc' },
        navigate,
        undefined,
      ),
    );

    expect(navigate).toHaveBeenCalledTimes(1);
    const search = navigate.mock.calls[0][0].search as Record<string, unknown>;
    // The view's status fills the missing key (proves a real hydration ran)…
    expect(search.status).toEqual(['todo']);
    // …but the URL's explicit sort wins over the view's 'next_action_due'.
    expect(search.sort).toBe('title');
    expect(search.dir).toBe('desc');
  });

  it('does NOT re-navigate when the URL already matches the view (idempotent)', () => {
    const navigate = vi.fn();
    // The URL already carries the view's stored status → no replace-navigate.
    renderHook(() =>
      useViewFilterHydration(
        view({ id: 'v1', filters: { status: ['todo'] } }),
        { status: ['todo'] },
        navigate,
        undefined,
      ),
    );

    expect(navigate).not.toHaveBeenCalled();
  });

  it('hydrates only once per view (the ref guard) even on re-render', () => {
    const navigate = vi.fn();
    const v = view({ id: 'v1', filters: { status: ['todo'] } });
    const { rerender } = renderHook(
      ({ search }: { search: Record<string, unknown> }) =>
        useViewFilterHydration(v, search, navigate, undefined),
      { initialProps: { search: {} } },
    );

    expect(navigate).toHaveBeenCalledTimes(1);
    // Re-render simulating the URL having updated post-hydration — must not fire again.
    rerender({ search: { status: ['todo'] } });
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('hydrates the next view when the active view switches', () => {
    const navigate = vi.fn();
    const v1 = view({ id: 'v1', filters: { status: ['todo'] } });
    const v2 = view({ id: 'v2', filters: { status: ['done'] } });
    const { rerender } = renderHook(
      ({ v }: { v: View }) => useViewFilterHydration(v, {}, navigate, undefined),
      { initialProps: { v: v1 } },
    );

    expect((navigate.mock.calls[0][0].search as Record<string, unknown>).status).toEqual(['todo']);

    // Switch the active view — the new view's saved filter must hydrate.
    rerender({ v: v2 });
    expect(navigate).toHaveBeenCalledTimes(2);
    expect((navigate.mock.calls[1][0].search as Record<string, unknown>).status).toEqual(['done']);
  });

  it('is a no-op when there is no active view', () => {
    const navigate = vi.fn();
    renderHook(() => useViewFilterHydration(null, {}, navigate, undefined));
    expect(navigate).not.toHaveBeenCalled();
  });
});
