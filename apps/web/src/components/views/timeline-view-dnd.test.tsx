import type { DndContextProps, DragEndEvent } from '@dnd-kit/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Capture the DndContext props the timeline wires up so we can drive onDragEnd
// synthetically (jsdom can't run a real dnd-kit pointer drag — no layout, no
// collision). All other dnd-kit exports stay REAL so the nested useDraggable /
// useDroppable hooks still function. vi.hoisted: the mock factory is hoisted
// above imports, so the shared ref must be too, or the factory closes over an
// uninitialized binding (TDZ).
const captured = vi.hoisted(() => ({ props: null as DndContextProps | null }));
vi.mock('@dnd-kit/core', async (importActual) => {
  const actual = await importActual<typeof import('@dnd-kit/core')>();
  const React = await import('react');
  return {
    ...actual,
    DndContext: (props: DndContextProps) => {
      captured.props = props;
      return React.createElement(actual.DndContext, props);
    },
    DragOverlay: ({ children }: { children?: React.ReactNode }) =>
      React.createElement('div', { 'data-testid': 'drag-overlay' }, children),
  };
});

import { TimelineView } from './timeline-view.tsx';

// Records the PATCH bodies + URLs the timeline's reschedule writes. The PATCH
// goes through the REAL useUpdateDocument → client.patch → fetch so the body is
// the genuine wire payload (invariant 16: it must hit /documents, never /views).
function setupTimeline(
  rows: Array<{ slug: string; title: string; frontmatter?: Record<string, unknown> }>,
  viewSettings: Record<string, unknown> = {},
) {
  const patches: Array<{
    slug: string;
    url: string;
    body: { frontmatter?: Record<string, unknown> };
  }> = [];
  const allWriteUrls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method !== 'GET') allWriteUrls.push(u);
      if (method === 'PATCH' && u.includes('/documents/')) {
        const slug = u.split('/documents/')[1]?.split(/[?#]/)[0] ?? '';
        patches.push({ slug, url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
        return new Response(JSON.stringify({ data: { slug } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // The active timeline view — carries the per-view date-field config so a
      // range doc (start_date/end_date) places as a RANGE bar. A timeline that
      // supports ranges always has startField/endField configured in prod.
      if (method === 'GET' && /\/t\/[^/]+\/views$/.test(u)) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'v1',
                tableSlug: 'work-items',
                name: 'Timeline',
                type: 'timeline',
                isDefault: true,
                position: 0,
                settings: viewSettings,
                createdAt: '',
                updatedAt: '',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/documents')) {
        return new Response(
          JSON.stringify({
            data: {
              data: rows.map((r, i) => ({
                id: `id-${i}`,
                slug: r.slug,
                type: 'work_item',
                title: r.title,
                status: null,
                parentId: null,
                frontmatter: r.frontmatter ?? {},
                createdAt: '',
                updatedAt: new Date().toISOString(),
              })),
              nextCursor: null,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // views / statuses / fields all return empty lists
      return new Response('{"data":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return { patches, allWriteUrls };
}

// The scale window is fixed via initialRange so the range is deterministic. The
// drag logic computes the new date from over.id (the target column's startIso),
// NOT from column geometry, so the exact zoom/column boundaries don't affect the
// asserted PATCH body — we drive over.id directly with the target ISO.
function setup(
  rows: Array<{ slug: string; title: string; frontmatter?: Record<string, unknown> }>,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const tl = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/timeline',
    validateSearch: z.object({ doc: z.string().optional() }),
    component: () => {
      const { wslug, pslug } = tl.useParams();
      return (
        <TimelineView
          wslug={wslug}
          pslug={pslug}
          tslug="work-items"
          initialRange={{ start: '2026-06-01', end: '2026-06-30' }}
        />
      );
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([tl]),
    history: createMemoryHistory({ initialEntries: ['/w/main/p/web/timeline'] }),
  });
  return { queryClient, router, rows };
}

function renderView(
  rows: Array<{ slug: string; title: string; frontmatter?: Record<string, unknown> }>,
) {
  const { queryClient, router } = setup(rows);
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('TimelineView DnD reschedule', () => {
  beforeEach(() => {
    captured.props = null;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the timeline wrapped in DndContext (onDragEnd wired)', async () => {
    const rows = [{ slug: 'a', title: 'Dated Task', frontmatter: { due_date: '2026-06-10' } }];
    setupTimeline(rows);
    renderView(rows);
    await waitFor(() => expect(screen.getByText('Dated Task')).toBeInTheDocument());
    await waitFor(() => expect(captured.props?.onDragEnd).toBeTypeOf('function'));
  });

  // THE single-date contract: dragging a bar to the column for a new day writes
  // the new ISO to the doc's date field. The body carries ONLY the changed key
  // (the server merge-patches), and the write hits /documents/<slug>.
  it('single-date drag PATCHes the document date field to the target day', async () => {
    const rows = [{ slug: 'a', title: 'Dated Task', frontmatter: { due_date: '2026-06-10' } }];
    const { patches } = setupTimeline(rows);
    renderView(rows);
    await waitFor(() => expect(screen.getByText('Dated Task')).toBeInTheDocument());
    await waitFor(() => expect(captured.props?.onDragEnd).toBeTypeOf('function'));

    await act(async () => {
      await captured.props?.onDragEnd?.({
        active: { id: 'a' },
        over: { id: '2026-06-20' },
      } as unknown as DragEndEvent);
    });

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]?.slug).toBe('a');
    expect(patches[0]?.body.frontmatter?.due_date).toBe('2026-06-20');
  });

  // THE load-bearing range contract: a 3-day-duration range dragged so its start
  // moves +7 days shifts BOTH ends by the SAME +7 — duration PRESERVED (still a
  // 3-day span: 06-12 → 06-15). This is the core Tier-A invariant of the task.
  it('range drag shifts BOTH dates by the same delta (duration preserved)', async () => {
    const rows = [
      {
        slug: 'r',
        title: 'Range Task',
        frontmatter: { start_date: '2026-06-05', end_date: '2026-06-08' },
      },
    ];
    const { patches } = setupTimeline(rows, {
      startField: 'start_date',
      endField: 'end_date',
    });
    renderView(rows);
    await waitFor(() => expect(screen.getByText('Range Task')).toBeInTheDocument());
    await waitFor(() => expect(captured.props?.onDragEnd).toBeTypeOf('function'));

    await act(async () => {
      await captured.props?.onDragEnd?.({
        active: { id: 'r' },
        over: { id: '2026-06-12' },
      } as unknown as DragEndEvent);
    });

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]?.slug).toBe('r');
    expect(patches[0]?.body.frontmatter?.start_date).toBe('2026-06-12');
    expect(patches[0]?.body.frontmatter?.end_date).toBe('2026-06-15');
  });

  // INVARIANT 16 (mandatory negative): the reschedule is a DOCUMENT write only.
  // NO write may target /views — the dates are document attributes, never view
  // config. Capture every non-GET write URL and assert none hit /views.
  it('the reschedule NEVER writes the view (invariant 16)', async () => {
    const rows = [
      {
        slug: 'r',
        title: 'Range Task',
        frontmatter: { start_date: '2026-06-05', end_date: '2026-06-08' },
      },
    ];
    const { allWriteUrls } = setupTimeline(rows, {
      startField: 'start_date',
      endField: 'end_date',
    });
    renderView(rows);
    await waitFor(() => expect(screen.getByText('Range Task')).toBeInTheDocument());
    await waitFor(() => expect(captured.props?.onDragEnd).toBeTypeOf('function'));

    await act(async () => {
      await captured.props?.onDragEnd?.({
        active: { id: 'r' },
        over: { id: '2026-06-12' },
      } as unknown as DragEndEvent);
    });

    await waitFor(() => expect(allWriteUrls.length).toBeGreaterThan(0));
    expect(allWriteUrls.every((u) => !u.includes('/views'))).toBe(true);
  });

  // No-op: dropping a bar back on its CURRENT start column fires no PATCH. Proven
  // deterministically by driving a KNOWN-GOOD reschedule through the same wire
  // afterward and asserting exactly ONE patch landed (the good one) — so the
  // same-day drop had its full chance to flush and produced nothing.
  it('dropping on the doc current start day is a no-op (no PATCH)', async () => {
    const rows = [{ slug: 'a', title: 'Dated Task', frontmatter: { due_date: '2026-06-10' } }];
    const { patches } = setupTimeline(rows);
    renderView(rows);
    await waitFor(() => expect(screen.getByText('Dated Task')).toBeInTheDocument());
    await waitFor(() => expect(captured.props?.onDragEnd).toBeTypeOf('function'));

    await act(async () => {
      await captured.props?.onDragEnd?.({
        active: { id: 'a' },
        over: { id: '2026-06-10' },
      } as unknown as DragEndEvent);
    });
    await act(async () => {
      await captured.props?.onDragEnd?.({
        active: { id: 'a' },
        over: { id: '2026-06-15' },
      } as unknown as DragEndEvent);
    });

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]?.body.frontmatter?.due_date).toBe('2026-06-15');
  });

  // Dropped outside any column (over === null) → no PATCH.
  it('a drop with no target (over null) is a no-op', async () => {
    const rows = [{ slug: 'a', title: 'Dated Task', frontmatter: { due_date: '2026-06-10' } }];
    const { patches } = setupTimeline(rows);
    renderView(rows);
    await waitFor(() => expect(screen.getByText('Dated Task')).toBeInTheDocument());
    await waitFor(() => expect(captured.props?.onDragEnd).toBeTypeOf('function'));

    await act(async () => {
      await captured.props?.onDragEnd?.({
        active: { id: 'a' },
        over: null,
      } as unknown as DragEndEvent);
    });
    await act(async () => {
      await captured.props?.onDragEnd?.({
        active: { id: 'a' },
        over: { id: '2026-06-22' },
      } as unknown as DragEndEvent);
    });

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]?.body.frontmatter?.due_date).toBe('2026-06-22');
  });
});
