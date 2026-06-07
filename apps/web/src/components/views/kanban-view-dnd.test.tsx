import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { closestCorners, MeasuringStrategy } from '@dnd-kit/core';
import type { DndContextProps, DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { z } from 'zod';

// Capture the DndContext props the view wires up so we can drive
// onDragStart / onDragEnd synthetically (jsdom can't run a real dnd-kit pointer
// drag — no layout, no collision). All other dnd-kit exports stay REAL so the
// nested useDroppable / useSortable / useDraggable hooks still function.
// vi.hoisted: the mock factory is hoisted above imports, so the shared ref must
// be too, or the factory closes over an uninitialized binding (TDZ).
const captured = vi.hoisted(() => ({ props: null as DndContextProps | null }));
vi.mock('@dnd-kit/core', async (importActual) => {
  const actual = await importActual<typeof import('@dnd-kit/core')>();
  const React = await import('react');
  // DndContext is a memo-wrapped exotic component, so it can't be invoked as a
  // plain function — render it as a JSX element with the captured props.
  return {
    ...actual,
    DndContext: (props: DndContextProps) => {
      captured.props = props;
      return React.createElement(actual.DndContext, props);
    },
    // The real DragOverlay only portals its children while a drag is live in
    // dnd-kit's internal store — which never happens under a synthetic drag in
    // jsdom. Stub it to render its children directly so we can prove the view
    // PASSES the active-card clone into the overlay (the BUG 1 fix).
    DragOverlay: ({ children }: { children?: React.ReactNode }) =>
      React.createElement('div', { 'data-testid': 'drag-overlay' }, children),
  };
});

import { KanbanView } from './kanban-view.tsx';

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const board = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/board',
    validateSearch: z.object({ doc: z.string().optional() }),
    component: () => {
      const { wslug, pslug } = board.useParams();
      return <KanbanView wslug={wslug} pslug={pslug} tslug="work-items" />;
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([board]),
    history: createMemoryHistory({ initialEntries: ['/w/main/p/web/board'] }),
  });
  return { queryClient, router };
}

describe('KanbanView DnD', () => {
  beforeEach(() => {
    captured.props = null;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders board wrapped in DndContext without crashing', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      if (u.includes('/statuses')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 's1', key: 'todo', name: 'Todo', color: '#6EAFFF', category: 'unstarted', order: 1 },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/documents')) {
        return new Response(
          JSON.stringify({
            data: {
              data: [
                {
                  id: 'd1',
                  slug: 'alpha',
                  type: 'work_item',
                  title: 'Alpha Task',
                  status: 'todo',
                  parentId: null,
                  frontmatter: {},
                  createdAt: '',
                  updatedAt: new Date().toISOString(),
                },
              ],
              nextCursor: null,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText('Alpha Task')).toBeInTheDocument());
    // DndContext is transparent — the card still renders and is accessible.
    expect(screen.getByText('Todo')).toBeInTheDocument();
  });

  // 4c: with a null sort (the default view's sort), the board is in MANUAL mode,
  // which now queries documents by board_position (previously parked → updated_at).
  // This is the un-mocked-fetch seam proving the listParams un-park is wired.
  it('manual mode (null sort) queries documents by board_position', async () => {
    const documentsUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      if (u.includes('/statuses')) {
        return new Response(
          JSON.stringify({ data: [{ id: 's1', key: 'todo', name: 'Todo', color: '#6EAFFF', category: 'unstarted', order: 1 }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/views')) {
        // Default view with NO sort → null effectiveSort → manual mode.
        return new Response(
          JSON.stringify({ data: [{ id: 'v1', name: 'Board', type: 'kanban', filters: {}, sort: null, groupBy: null, visibleFields: null, columnOrder: null, isDefault: true, order: 1 }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/documents')) {
        documentsUrls.push(u);
        return new Response(
          JSON.stringify({ data: { data: [{ id: 'd1', slug: 'a', type: 'work_item', title: 'Alpha Task', status: 'todo', parentId: null, boardPosition: 'm', frontmatter: {}, createdAt: '', updatedAt: new Date().toISOString() }], nextCursor: null } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText('Alpha Task')).toBeInTheDocument());
    // The board queried board_position, not the old parked updated_at default.
    await waitFor(() => expect(documentsUrls.some((u) => u.includes('sort=board_position'))).toBe(true));
    expect(documentsUrls.some((u) => u.includes('sort=updated_at'))).toBe(false);
  });

  // 4c: a NON-null sort (field sort) keeps querying by that field — board_position
  // is manual-only. Negative case for the un-park.
  it('a field sort still queries by that field (board_position is manual-only)', async () => {
    const documentsUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      if (u.includes('/statuses')) {
        return new Response(
          JSON.stringify({ data: [{ id: 's1', key: 'todo', name: 'Todo', color: '#6EAFFF', category: 'unstarted', order: 1 }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/views')) {
        return new Response(
          JSON.stringify({ data: [{ id: 'v1', name: 'Board', type: 'kanban', filters: {}, sort: [{ key: 'title', dir: 'asc' }], groupBy: null, visibleFields: null, columnOrder: null, isDefault: true, order: 1 }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/documents')) {
        documentsUrls.push(u);
        return new Response(
          JSON.stringify({ data: { data: [{ id: 'd1', slug: 'a', type: 'work_item', title: 'Alpha Task', status: 'todo', parentId: null, boardPosition: null, frontmatter: {}, createdAt: '', updatedAt: new Date().toISOString() }], nextCursor: null } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText('Alpha Task')).toBeInTheDocument());
    // Once the field-sorted view resolves, the EFFECTIVE (latest) query sorts by
    // that field — not board_position. (A board_position fetch may occur on the
    // first render before the view loads — that transient is expected; the
    // settled query is what matters.)
    await waitFor(() => expect(documentsUrls.some((u) => u.includes('sort=title'))).toBe(true));
    await waitFor(() => expect(documentsUrls.at(-1)).toContain('sort=title'));
  });

  // ── Bug-fix seam (2026-06-07): drag overlay + closestCorners ──────────────
  //
  // BUG 1 — the dragged card rendered BEHIND the columns (no DragOverlay; the
  // in-place card's z-index was clipped by the column's overflow-y-auto).
  // BUG 2 — a within-column card-over-card drop never persisted because the
  // default rectIntersection collision favored the big column droppable, so
  // over.id was col-* → resolveDrop → {kind:'none'} → no PATCH.
  //
  // jsdom can't drive a real dnd-kit pointer drag (no layout/collision), so we
  // mock DndContext to capture its props, drive onDragStart/onDragEnd
  // synthetically with a card over.id, and assert the wired persist path fires.

  // A manual-mode board (null sort) with TWO cards in the SAME (todo) column.
  // Returns the recorded PATCH bodies keyed by the slug in the URL.
  function setupTwoCardBoard() {
    const patches: Array<{ slug: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'PATCH' && u.includes('/documents/')) {
        const slug = u.split('/documents/')[1]?.split(/[?#]/)[0] ?? '';
        patches.push({ slug, body: init?.body ? JSON.parse(String(init.body)) : null });
        return new Response(JSON.stringify({ data: { slug } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/statuses')) {
        return new Response(
          JSON.stringify({ data: [{ id: 's1', key: 'todo', name: 'Todo', color: '#6EAFFF', category: 'unstarted', order: 1 }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/views')) {
        // No sort → manual mode → reorderEnabled, cards sortable.
        return new Response(
          JSON.stringify({ data: [{ id: 'v1', name: 'Board', type: 'kanban', filters: {}, sort: null, groupBy: null, visibleFields: null, columnOrder: null, isDefault: true, order: 1 }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/documents')) {
        return new Response(
          JSON.stringify({
            data: {
              data: [
                { id: 'd1', slug: 'alpha', type: 'work_item', title: 'Alpha Task', status: 'todo', parentId: null, boardPosition: 'a', frontmatter: {}, createdAt: '', updatedAt: new Date().toISOString() },
                { id: 'd2', slug: 'bravo', type: 'work_item', title: 'Bravo Task', status: 'todo', parentId: null, boardPosition: 'c', frontmatter: {}, createdAt: '', updatedAt: new Date().toISOString() },
              ],
              nextCursor: null,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    return { patches };
  }

  // BUG 2: the board wires collisionDetection so a card-over-card drop reports
  // the card (not col-*). Asserts the algorithm is set — without it, the default
  // rectIntersection steals the drop to the column and the reorder silently dies.
  it('wires a collisionDetection algorithm on the DndContext (closestCorners)', async () => {
    setupTwoCardBoard();
    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText('Alpha Task')).toBeInTheDocument());
    // Must be closestCorners specifically — the algorithm that reports the
    // over-CARD (not the column) on a within-column drop. The default
    // (rectIntersection / undefined) is the bug.
    expect(captured.props?.collisionDetection).toBe(closestCorners);
  });

  // BUG 2 (the persist seam): drive onDragEnd with an over.id that is a CARD id
  // (what closestCorners now delivers on a within-column drop) → the wired path
  // produces a boardPosition PATCH. This is exactly the gesture the old default
  // collision could never trigger.
  it('onDragEnd with a card over.id (same column) persists a boardPosition patch', async () => {
    const { patches } = setupTwoCardBoard();
    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText('Alpha Task')).toBeInTheDocument());
    await waitFor(() => expect(captured.props?.onDragEnd).toBeTypeOf('function'));

    // Drag Bravo (d2) and drop it ON Alpha (d1) — a card-over-card same-column
    // reorder. over.id is the OVER-CARD's id, not col-*.
    const event = {
      active: { id: 'd2', data: { current: { slug: 'bravo', currentStatus: 'todo' } } },
      over: { id: 'd1' },
    } as unknown as DragEndEvent;
    await act(async () => {
      await captured.props?.onDragEnd?.(event);
    });

    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    expect(patches[0]?.slug).toBe('bravo');
    expect(patches[0]?.body).toMatchObject({ boardPosition: expect.any(String) });
  });

  // Negative: a same-group WHITESPACE drop (over.id = col-*) is a no-op — proves
  // closestCorners didn't break the "empty column drop regroups, same-column
  // whitespace does nothing" boundary. No PATCH should fire.
  it('onDragEnd with a same-group column over.id does NOT persist', async () => {
    const { patches } = setupTwoCardBoard();
    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText('Alpha Task')).toBeInTheDocument());
    await waitFor(() => expect(captured.props?.onDragEnd).toBeTypeOf('function'));

    const event = {
      active: { id: 'd2', data: { current: { slug: 'bravo', currentStatus: 'todo' } } },
      over: { id: 'col-todo' },
    } as unknown as DragEndEvent;
    await act(async () => {
      await captured.props?.onDragEnd?.(event);
    });
    // Let any (incorrect) mutation flush.
    await new Promise((r) => setTimeout(r, 20));
    expect(patches.length).toBe(0);
  });

  // Stale-measurement fix (2026-06-08): after a cross-column move, the just-moved
  // card's column had a STALE dnd-kit rect (measured at drag-start), so no gap
  // opened and it couldn't be reordered until another drag forced a re-measure
  // ("I first have to move another item"). The DndContext now sets
  // measuring.droppable.strategy = Always so droppables re-measure every render
  // during a drag. (The visible gap + re-measure are real-layout behaviors jsdom
  // can't render; this asserts the config is wired — the actual gap is e2e/human-
  // verified in the browser.)
  it('configures Always droppable measuring so a just-moved card re-measures', async () => {
    setupTwoCardBoard();
    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText('Alpha Task')).toBeInTheDocument());
    expect(captured.props?.measuring?.droppable?.strategy).toBe(MeasuringStrategy.Always);
  });

  // ── ISSUE 1 seam (2026-06-07): auto-switch to Manual on a sorted-mode reorder ─
  //
  // A board defaulting to a field sort (e.g. title) renders cards as plain
  // draggables historically; a same-column card-over-card drop resolved to
  // {kind:'none'} → nothing happened, with no feedback. The fix: cards are
  // always sortable (so over.id is a CARD), and a same-column card drop in
  // sorted mode = `auto-manual-reorder` → onDragEnd (a) flips Sort→Manual via
  // the bus + persists `sort: []` on the active view, AND (b) writes the
  // boardPosition reorder so the card lands where dropped.

  // A SORTED board (title asc) with two cards in the SAME (todo) column.
  // Records BOTH the view PATCH (the auto-switch persist) and the document
  // PATCH (the reorder), keyed by url.
  function setupSortedTwoCardBoard() {
    const viewPatches: Array<{ id: string; body: unknown }> = [];
    const docPatches: Array<{ slug: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'PATCH' && u.includes('/views/')) {
        const id = u.split('/views/')[1]?.split(/[?#]/)[0] ?? '';
        viewPatches.push({ id, body: init?.body ? JSON.parse(String(init.body)) : null });
        return new Response(JSON.stringify({ data: { view: { id } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'PATCH' && u.includes('/documents/')) {
        const slug = u.split('/documents/')[1]?.split(/[?#]/)[0] ?? '';
        docPatches.push({ slug, body: init?.body ? JSON.parse(String(init.body)) : null });
        return new Response(JSON.stringify({ data: { slug } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/statuses')) {
        return new Response(
          JSON.stringify({ data: [{ id: 's1', key: 'todo', name: 'Todo', color: '#6EAFFF', category: 'unstarted', order: 1 }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/views')) {
        // A NON-null sort → sorted mode → reorderEnabled is false.
        return new Response(
          JSON.stringify({ data: [{ id: 'v1', name: 'Board', type: 'kanban', filters: {}, sort: [{ key: 'title', dir: 'asc' }], groupBy: null, visibleFields: null, columnOrder: null, isDefault: true, order: 1 }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/documents')) {
        return new Response(
          JSON.stringify({
            data: {
              data: [
                { id: 'd1', slug: 'alpha', type: 'work_item', title: 'Alpha Task', status: 'todo', parentId: null, boardPosition: 'a', frontmatter: {}, createdAt: '', updatedAt: new Date().toISOString() },
                { id: 'd2', slug: 'bravo', type: 'work_item', title: 'Bravo Task', status: 'todo', parentId: null, boardPosition: 'c', frontmatter: {}, createdAt: '', updatedAt: new Date().toISOString() },
              ],
              nextCursor: null,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    return { viewPatches, docPatches };
  }

  it('sorted-mode same-column card drop auto-switches to Manual (persists sort:[]) AND writes a boardPosition patch', async () => {
    const { viewPatches, docPatches } = setupSortedTwoCardBoard();
    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText('Alpha Task')).toBeInTheDocument());
    await waitFor(() => expect(captured.props?.onDragEnd).toBeTypeOf('function'));

    // Drag Bravo (d2) onto Alpha (d1) — a same-column card-over-card drop while a
    // field sort (title) is active. over.id is the over-CARD's id (cards are
    // always sortable now). Old behavior: resolveDrop → {none}, no PATCH at all.
    const event = {
      active: { id: 'd2', data: { current: { slug: 'bravo', currentStatus: 'todo' } } },
      over: { id: 'd1' },
    } as unknown as DragEndEvent;
    await act(async () => {
      await captured.props?.onDragEnd?.(event);
    });

    // (a) the active view was flipped to Manual: persisted sort is the empty
    // array (board-controls' "manual" convention).
    await waitFor(() => expect(viewPatches.length).toBeGreaterThan(0));
    expect(viewPatches[0]?.id).toBe('v1');
    expect(viewPatches[0]?.body).toMatchObject({ sort: [] });

    // (b) the reorder was applied: a boardPosition patch on the dragged card.
    await waitFor(() => expect(docPatches.length).toBeGreaterThan(0));
    expect(docPatches[0]?.slug).toBe('bravo');
    expect(docPatches[0]?.body).toMatchObject({ boardPosition: expect.any(String) });
  });

  // BUG 1: a DragOverlay renders the active card clone once a drag starts. The
  // overlay portals above the columns (escaping their overflow clip), fixing the
  // "card renders behind the columns" bug. Driven via onDragStart → re-render.
  it('renders the dragged card in a DragOverlay clone after drag start', async () => {
    setupTwoCardBoard();
    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText('Bravo Task')).toBeInTheDocument());
    await waitFor(() => expect(captured.props?.onDragStart).toBeTypeOf('function'));

    // Before drag: exactly one Bravo card (the in-place one).
    expect(screen.getAllByText('Bravo Task')).toHaveLength(1);

    const startEvent = {
      active: { id: 'd2', data: { current: { slug: 'bravo' } } },
    } as unknown as DragStartEvent;
    act(() => {
      captured.props?.onDragStart?.(startEvent);
    });

    // After drag start: the overlay clone appears → TWO Bravo nodes (in-place +
    // overlay). The in-place one dims to opacity:0 but stays in the DOM.
    await waitFor(() => expect(screen.getAllByText('Bravo Task')).toHaveLength(2));
  });
});
