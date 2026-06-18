import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { TimelineView } from './timeline-view.tsx';

// One timeline-typed default view. settings carries the per-view config the
// component reads (startField/endField/fallbackField/zoom). `id` is the target
// the zoom PATCH must write — the invariant-16 assertion checks the PATCH lands
// on THIS view, not on a document.
const VIEW_ID = 'view-timeline-1';

function viewRow(settings: Record<string, unknown>) {
  return {
    id: VIEW_ID,
    name: 'Timeline',
    type: 'timeline',
    filters: null,
    sort: null,
    groupBy: null,
    visibleFields: null,
    columnOrder: null,
    settings,
    isDefault: true,
    order: 0,
  };
}

function docsResponse(
  rows: Array<{ slug: string; title: string; frontmatter?: Record<string, unknown> }>,
) {
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

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

function stubFetch(
  rows: Array<{ slug: string; title: string; frontmatter?: Record<string, unknown> }>,
  opts: { documentsError?: boolean; viewSettings?: Record<string, unknown> } = {},
): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      let body: unknown = null;
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      calls.push({ url: u, method, body });

      // The views list — return our timeline view so useActiveView resolves it.
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [viewRow(opts.viewSettings ?? {})] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // A view PATCH (zoom persist) — echo a view back.
      if (u.includes('/views/') && method === 'PATCH') {
        return new Response(JSON.stringify({ data: { view: viewRow(opts.viewSettings ?? {}) } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents')) {
        if (opts.documentsError) {
          return new Response(JSON.stringify({ error: { code: 'boom', message: 'boom' } }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          });
        }
        return docsResponse(rows);
      }
      // statuses / fields → empty lists
      return new Response('{"data":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

function setup(viewSettings?: Record<string, unknown>, initialEntry = '/w/main/p/web/timeline') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const tl = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/timeline',
    validateSearch: z.object({
      doc: z.string().optional(),
      view: z.string().optional(),
      status: z.union([z.string(), z.array(z.string())]).optional(),
    }),
    component: () => {
      const { wslug, pslug } = tl.useParams();
      return (
        <TimelineView
          wslug={wslug}
          pslug={pslug}
          tslug="work-items"
          // Deterministic scale window so column-bucketed assertions don't depend
          // on today's date. Spans June 2026 — the test docs' dates fall inside.
          initialRange={{ start: '2026-06-01', end: '2026-06-30' }}
        />
      );
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([tl]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  return { queryClient, router };
}

function renderView(viewSettings?: Record<string, unknown>, initialEntry?: string) {
  const { queryClient, router } = setup(viewSettings, initialEntry);
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router };
}

describe('TimelineView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the time scale columns', async () => {
    stubFetch([{ slug: 'a', title: 'Task A', frontmatter: { due_date: '2026-06-10' } }], {
      viewSettings: { zoom: 'week' },
    });
    renderView();
    // The scale header renders at least one column for the June window.
    await waitFor(() => expect(screen.getAllByTestId('timeline-col').length).toBeGreaterThan(0));
  });

  it('places a range doc (start+end) as a multi-column bar', async () => {
    // week zoom over June: 2026-06-02 and 2026-06-20 are ~3 weeks apart → span > 1.
    const calls = stubFetch(
      [
        {
          slug: 'range',
          title: 'Range Task',
          frontmatter: { start_date: '2026-06-02', end_date: '2026-06-20' },
        },
      ],
      { viewSettings: { zoom: 'week', startField: 'start_date', endField: 'end_date' } },
    );
    void calls;
    renderView();
    const bar = await screen.findByTestId('timeline-bar-range');
    // grid-column span encodes the colSpan; a range doc spans more than one column.
    const span = bar.style.gridColumn;
    expect(span).toMatch(/span ([2-9]|\d{2,})/);
  });

  it('places a single-date doc as a one-column bar', async () => {
    stubFetch([{ slug: 'single', title: 'Single', frontmatter: { due_date: '2026-06-10' } }], {
      viewSettings: { zoom: 'week' },
    });
    renderView();
    const bar = await screen.findByTestId('timeline-bar-single');
    expect(bar.style.gridColumn).toMatch(/span 1\b/);
  });

  it('clicking a bar opens the slideover via ?doc=', async () => {
    stubFetch([{ slug: 'single', title: 'Single', frontmatter: { due_date: '2026-06-10' } }], {
      viewSettings: { zoom: 'week' },
    });
    const { router } = renderView();
    await userEvent.click(await screen.findByTestId('timeline-bar-single'));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ doc: 'single' }));
  });

  // B.6 MOVED: the zoom toggle moved from TimelineView to the unified
  // ViewControls (project header). The Tier-A slice — "a zoom change PATCHes
  // settings.zoom on the VIEW, never a document, preserving sibling settings" —
  // now lives, un-weakened, in view-controls.test.tsx ("timeline zoom change
  // PATCHes settings.zoom"). TimelineView still READS settings.zoom to render
  // the scale (the "renders bars under the configured zoom" cases above prove
  // the read path).

  it('shows an empty state when there are zero dated docs', async () => {
    stubFetch([{ slug: 'u', title: 'No Date', frontmatter: {} }], {
      viewSettings: { zoom: 'week' },
    });
    renderView();
    await waitFor(() => expect(screen.getByTestId('timeline-empty')).toBeInTheDocument());
  });

  it('shows an error affordance when the documents fetch fails', async () => {
    stubFetch([], { documentsError: true, viewSettings: { zoom: 'week' } });
    renderView();
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });

  // C1 (filter-on-every-view): a status filter in the URL must reach the
  // documents fetch — the timeline's data hook previously hard-coded
  // { type:'work_item', limit:200 } and ignored the shared FilterBar's URL state.
  it('a status filter in the URL narrows the documents fetch (status reaches the wire)', async () => {
    const calls = stubFetch(
      [{ slug: 'a', title: 'Task A', frontmatter: { due_date: '2026-06-10' } }],
      { viewSettings: { zoom: 'week' } },
    );
    renderView(undefined, '/w/main/p/web/timeline?status=done');
    await waitFor(() => expect(calls.some((c) => c.url.includes('/documents'))).toBe(true));
    expect(calls.some((c) => c.url.includes('/documents') && c.url.includes('status=done'))).toBe(
      true,
    );
  });

  // Negative case: NO filter in the URL → no status param leaks onto the wire.
  it('no filter in the URL leaves status off the documents fetch', async () => {
    const calls = stubFetch(
      [{ slug: 'a', title: 'Task A', frontmatter: { due_date: '2026-06-10' } }],
      { viewSettings: { zoom: 'week' } },
    );
    renderView();
    await waitFor(() => expect(calls.some((c) => c.url.includes('/documents'))).toBe(true));
    expect(
      calls.filter((c) => c.url.includes('/documents')).every((c) => !c.url.includes('status=')),
    ).toBe(true);
  });
});
