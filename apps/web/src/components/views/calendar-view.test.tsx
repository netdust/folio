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
import { CalendarView } from './calendar-view.tsx';

// Doc rows the fetch mock returns. Dates are chosen to land in the rendered
// month (the component is pinned to June 2026 via the `initialMonth` test seam).
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

function stubFetch(
  rows: Array<{ slug: string; title: string; frontmatter?: Record<string, unknown> }>,
  opts: { documentsError?: boolean } = {},
): { documentsUrls: string[] } {
  const documentsUrls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      if (u.includes('/documents')) {
        documentsUrls.push(u);
        if (opts.documentsError) {
          return new Response(JSON.stringify({ error: { code: 'boom', message: 'boom' } }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          });
        }
        return docsResponse(rows);
      }
      // views / statuses / fields all return empty lists
      return new Response('{"data":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return { documentsUrls };
}

function setup(initialEntry = '/w/main/p/web/calendar') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const cal = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/calendar',
    validateSearch: z.object({
      doc: z.string().optional(),
      status: z.union([z.string(), z.array(z.string())]).optional(),
    }),
    component: () => {
      const { wslug, pslug } = cal.useParams();
      return (
        <CalendarView
          wslug={wslug}
          pslug={pslug}
          tslug="work-items"
          // Pin to June 2026 so date-bucketed assertions are deterministic.
          initialMonth={{ year: 2026, month: 6 }}
        />
      );
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([cal]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  return { queryClient, router };
}

function renderView(initialEntry?: string) {
  const { queryClient, router } = setup(initialEntry);
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router };
}

describe('CalendarView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders a 42-cell month grid', async () => {
    stubFetch([]);
    renderView();
    await waitFor(() => expect(screen.getAllByTestId('calendar-day-cell')).toHaveLength(42));
  });

  it('places a dated doc into its day cell', async () => {
    stubFetch([{ slug: 'a', title: 'Dated Task', frontmatter: { due_date: '2026-06-10' } }]);
    renderView();
    const cell = await screen.findByTestId('calendar-cell-2026-06-10');
    expect(cell.textContent).toContain('Dated Task');
  });

  it('clicking a doc chip opens the slideover via ?doc=', async () => {
    stubFetch([{ slug: 'a', title: 'Dated Task', frontmatter: { due_date: '2026-06-10' } }]);
    const { router } = renderView();
    await userEvent.click(await screen.findByText('Dated Task'));
    await waitFor(() => expect(router.state.location.search).toEqual({ doc: 'a' }));
  });

  it('puts an undated doc into the Unscheduled tray', async () => {
    stubFetch([{ slug: 'u', title: 'No Date Task', frontmatter: {} }]);
    renderView();
    const tray = await screen.findByTestId('calendar-unscheduled');
    expect(tray.textContent).toContain('Unscheduled');
    expect(tray.textContent).toContain('No Date Task');
  });

  it('shows an empty state when there are zero docs', async () => {
    stubFetch([]);
    renderView();
    await waitFor(() => expect(screen.getByTestId('calendar-empty')).toBeInTheDocument());
  });

  it('next-month nav advances the rendered month label', async () => {
    stubFetch([]);
    renderView();
    expect(await screen.findByTestId('calendar-month-label')).toHaveTextContent(/June 2026/i);
    await userEvent.click(screen.getByLabelText('Next month'));
    await waitFor(() =>
      expect(screen.getByTestId('calendar-month-label')).toHaveTextContent(/July 2026/i),
    );
  });

  it('shows an error affordance when the documents fetch fails', async () => {
    stubFetch([], { documentsError: true });
    renderView();
    await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
  });

  // C1 (filter-on-every-view): a status filter in the URL must reach the
  // documents fetch — the shared FilterBar PATCHes the URL search, and the
  // calendar's data hook must narrow by it (it previously hard-coded
  // { type:'work_item', limit:200 } and ignored the filter entirely).
  it('a status filter in the URL narrows the documents fetch (status reaches the wire)', async () => {
    const { documentsUrls } = stubFetch([
      { slug: 'a', title: 'Dated Task', frontmatter: { due_date: '2026-06-10' } },
    ]);
    renderView('/w/main/p/web/calendar?status=done');
    await waitFor(() => expect(documentsUrls.length).toBeGreaterThan(0));
    expect(documentsUrls.some((u) => u.includes('status=done'))).toBe(true);
  });

  // Negative case: NO filter in the URL → no status param leaks onto the wire.
  it('no filter in the URL leaves status off the documents fetch', async () => {
    const { documentsUrls } = stubFetch([
      { slug: 'a', title: 'Dated Task', frontmatter: { due_date: '2026-06-10' } },
    ]);
    renderView();
    await waitFor(() => expect(documentsUrls.length).toBeGreaterThan(0));
    expect(documentsUrls.every((u) => !u.includes('status='))).toBe(true);
  });
});
