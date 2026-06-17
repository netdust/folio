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

// Capture the DndContext props the view wires up so we can drive onDragEnd
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

import { CalendarView } from './calendar-view.tsx';

// Records the PATCH bodies + URLs the calendar's reschedule writes. The PATCH
// goes through the REAL useUpdateDocument → client.patch → fetch so the body is
// the genuine wire payload (invariant 16: it must hit /documents, never /views).
function setupCalendar(
  rows: Array<{ slug: string; title: string; frontmatter?: Record<string, unknown> }>,
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

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const cal = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/calendar',
    validateSearch: z.object({ doc: z.string().optional() }),
    component: () => {
      const { wslug, pslug } = cal.useParams();
      return (
        <CalendarView
          wslug={wslug}
          pslug={pslug}
          tslug="work-items"
          initialMonth={{ year: 2026, month: 6 }}
        />
      );
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([cal]),
    history: createMemoryHistory({ initialEntries: ['/w/main/p/web/calendar'] }),
  });
  return { queryClient, router };
}

function renderView() {
  const { queryClient, router } = setup();
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('CalendarView DnD reschedule', () => {
  beforeEach(() => {
    captured.props = null;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the calendar wrapped in DndContext (onDragEnd wired)', async () => {
    setupCalendar([{ slug: 'a', title: 'Dated Task', frontmatter: { due_date: '2026-06-10' } }]);
    renderView();
    await waitFor(() => expect(screen.getByText('Dated Task')).toBeInTheDocument());
    await waitFor(() => expect(captured.props?.onDragEnd).toBeTypeOf('function'));
  });

  // THE contract: dragging a chip from day A to day B writes the new ISO to the
  // DOCUMENT's date field. The body carries ONLY the changed dateField key (the
  // server merge-patches), and the write hits /documents/<slug>.
  it('drag from one day to another PATCHes the document date field to the target day', async () => {
    const { patches } = setupCalendar([
      { slug: 'a', title: 'Dated Task', frontmatter: { due_date: '2026-06-10' } },
    ]);
    renderView();
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

  // INVARIANT 16 (mandatory negative): the reschedule is a DOCUMENT write only.
  // NO write may target /views — the date is a document attribute, never view
  // config. Capture every non-GET write URL and assert none hit /views.
  it('the reschedule NEVER writes the view (invariant 16)', async () => {
    const { allWriteUrls } = setupCalendar([
      { slug: 'a', title: 'Dated Task', frontmatter: { due_date: '2026-06-10' } },
    ]);
    renderView();
    await waitFor(() => expect(screen.getByText('Dated Task')).toBeInTheDocument());
    await waitFor(() => expect(captured.props?.onDragEnd).toBeTypeOf('function'));

    await act(async () => {
      await captured.props?.onDragEnd?.({
        active: { id: 'a' },
        over: { id: '2026-06-20' },
      } as unknown as DragEndEvent);
    });

    await waitFor(() => expect(allWriteUrls.length).toBeGreaterThan(0));
    expect(allWriteUrls.every((u) => !u.includes('/views'))).toBe(true);
  });

  // No-op: dropping a chip back on its CURRENT day fires no PATCH. Proven
  // deterministically by driving a KNOWN-GOOD reschedule through the same wire
  // afterward and asserting exactly ONE patch landed (the good one) — so the
  // same-day drop had its full chance to flush and produced nothing.
  it('dropping on the same day is a no-op (no PATCH)', async () => {
    const { patches } = setupCalendar([
      { slug: 'a', title: 'Dated Task', frontmatter: { due_date: '2026-06-10' } },
    ]);
    renderView();
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

  // Unscheduled → day: an undated chip dragged to a cell SETS the date (no-date
  // → that day). over.id is the target ISO; this is the natural consequence.
  it('an unscheduled chip dragged to a day sets the date field', async () => {
    const { patches } = setupCalendar([{ slug: 'u', title: 'No Date Task', frontmatter: {} }]);
    renderView();
    await waitFor(() => expect(screen.getByText('No Date Task')).toBeInTheDocument());
    await waitFor(() => expect(captured.props?.onDragEnd).toBeTypeOf('function'));

    await act(async () => {
      await captured.props?.onDragEnd?.({
        active: { id: 'u' },
        over: { id: '2026-06-18' },
      } as unknown as DragEndEvent);
    });

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]?.slug).toBe('u');
    expect(patches[0]?.body.frontmatter?.due_date).toBe('2026-06-18');
  });

  // Dropped outside any cell (over === null) → no PATCH.
  it('a drop with no target (over null) is a no-op', async () => {
    const { patches } = setupCalendar([
      { slug: 'a', title: 'Dated Task', frontmatter: { due_date: '2026-06-10' } },
    ]);
    renderView();
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
