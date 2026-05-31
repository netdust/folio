import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { z } from 'zod';
import { KanbanView } from './kanban-view.tsx';
import { boardControlsBus } from '../../lib/board-controls-bus.ts';

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

describe('KanbanView', () => {
  beforeEach(() => boardControlsBus.reset());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    boardControlsBus.reset();
  });

  it('groups cards by status column', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      if (u.includes('/statuses')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 's1', key: 'todo', name: 'Todo', color: '#6EAFFF', category: 'unstarted', order: 1 },
              { id: 's2', key: 'doing', name: 'In progress', color: '#F0A442', category: 'started', order: 2 },
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
                { id: 'd1', slug: 'a', type: 'work_item', title: 'Card A', status: 'todo', parentId: null, frontmatter: {}, createdAt: '', updatedAt: new Date().toISOString() },
                { id: 'd2', slug: 'b', type: 'work_item', title: 'Card B', status: 'doing', parentId: null, frontmatter: { priority: 'high' }, createdAt: '', updatedAt: new Date().toISOString() },
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
    await waitFor(() => expect(screen.getByText('Card A')).toBeInTheDocument());
    expect(screen.getByText('Card B')).toBeInTheDocument();
    expect(screen.getByText('high')).toBeInTheDocument();
  });

  // Bug F (2026-05-26): the parking-lot "No status" column header used to use
  // a different className from the status-column header (mb-2 px-1 vs the
  // status column's mb-1 px-2 py-1), so its text sat ~4-6px higher than the
  // status columns. The fix is to mirror the layout — including a count
  // badge so the rendered height matches the other headers.
  it('No-status header has the same vertical layout as status-column headers (count + matching padding)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (url) => {
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
                  // Two docs without a status — these land in the no-status parking lot.
                  { id: 'd1', slug: 'a', type: 'work_item', title: 'Card A', status: null, parentId: null, frontmatter: {}, createdAt: '', updatedAt: new Date().toISOString() },
                  { id: 'd2', slug: 'b', type: 'work_item', title: 'Card B', status: null, parentId: null, frontmatter: {}, createdAt: '', updatedAt: new Date().toISOString() },
                ],
                nextCursor: null,
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );

    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    const noStatusHeader = await screen.findByText('No status');
    // Header padding + bottom margin must match status-column headers exactly.
    const wrapper = noStatusHeader.parentElement!;
    expect(wrapper.className).toContain('mb-1');
    expect(wrapper.className).toContain('px-2');
    expect(wrapper.className).toContain('py-1');
    // Count of cards in the parking lot is rendered alongside the title so
    // the header height matches columns that have a count.
    expect(wrapper.textContent).toMatch(/No status\s*2/);
  });

  it('clicking a card opens the slideover via ?doc=', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      if (u.includes('/statuses')) {
        return new Response(
          JSON.stringify({ data: [{ id: 's1', key: 'todo', name: 'Todo', color: '#6EAFFF', category: 'unstarted', order: 1 }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/documents')) {
        return new Response(
          JSON.stringify({ data: { data: [{ id: 'd1', slug: 'a', type: 'work_item', title: 'Card A', status: 'todo', parentId: null, frontmatter: {}, createdAt: '', updatedAt: new Date().toISOString() }], nextCursor: null } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    await userEvent.click(await screen.findByText('Card A'));
    await waitFor(() => expect(router.state.location.search).toEqual({ doc: 'a' }));
  });

  it('groups by a field (view.groupBy) using the field options as columns', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (url) => {
        const u = String(url);
        if (u.includes('/statuses')) {
          return new Response(
            JSON.stringify({ data: [{ id: 's1', key: 'todo', name: 'Todo', color: '#6EAFFF', category: 'unstarted', order: 1 }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (u.includes('/views')) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: 'v1',
                  name: 'Board',
                  type: 'kanban',
                  filters: {},
                  sort: null,
                  groupBy: 'priority',
                  visibleFields: null,
                  columnOrder: null,
                  isDefault: true,
                  order: 1,
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (u.includes('/fields')) {
          return new Response(
            JSON.stringify({
              data: [
                { id: 'f1', key: 'priority', type: 'select', label: 'Priority', options: ['Low', 'High'], required: false, order: 1 },
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
                  { id: 'd1', slug: 'a', type: 'work_item', title: 'Card A', status: null, parentId: null, frontmatter: { priority: 'High' }, createdAt: '', updatedAt: new Date().toISOString() },
                ],
                nextCursor: null,
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );

    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    // Columns come from the field options, not statuses. Locate columns via the
    // add-button aria-label which is unambiguous (the card's priority badge also
    // renders the text "High", so a plain text query would be ambiguous).
    const lowHeader = await screen.findByLabelText('New work item in Low');
    const highHeader = await screen.findByLabelText('New work item in High');
    expect(lowHeader).toBeInTheDocument();
    expect(highHeader).toBeInTheDocument();
    // The card with priority=High renders under the "High" column.
    const cardA = await screen.findByText('Card A');
    expect(cardA).toBeInTheDocument();
    const highColumn = highHeader.closest('div.flex.w-\\[280px\\]');
    const lowColumn = lowHeader.closest('div.flex.w-\\[280px\\]');
    expect(highColumn).not.toBeNull();
    expect(highColumn!.textContent).toContain('Card A');
    expect(lowColumn!.textContent).not.toContain('Card A');
  });

  // BF1 (2026-05-31): the default board is reached at `/board` with NO `?view=`
  // param. The old code gated group-by/sort behind a "view is URL-pinned" check
  // and early-returned otherwise, so selecting Manual silently did nothing.
  // Now changes apply ad-hoc via the module bus regardless of `?view=`:
  // selecting Manual switches the documents fetch to `sort=board_position`.
  it('selecting Manual applies ad-hoc without ?view= (fetch switches to board_position)', async () => {
    const documentsUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (url) => {
        const u = String(url);
        if (u.includes('/statuses')) {
          return new Response(
            JSON.stringify({ data: [{ id: 's1', key: 'todo', name: 'Todo', color: '#6EAFFF', category: 'unstarted', order: 1 }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (u.includes('/views')) {
          // Default view with a FIELD sort (title) — not manual. Selecting
          // Manual must override it ad-hoc and refetch by board_position.
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: 'v1',
                  name: 'Board',
                  type: 'kanban',
                  filters: {},
                  sort: [{ key: 'title', dir: 'asc' }],
                  groupBy: null,
                  visibleFields: null,
                  columnOrder: null,
                  isDefault: true,
                  order: 1,
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (u.includes('/documents')) {
          documentsUrls.push(u);
          return new Response(
            JSON.stringify({
              data: {
                data: [{ id: 'd1', slug: 'a', type: 'work_item', title: 'Card A', status: 'todo', parentId: null, frontmatter: {}, createdAt: '', updatedAt: new Date().toISOString() }],
                nextCursor: null,
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );

    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText('Card A')).toBeInTheDocument());

    // No `?view=` was set, and once the view loaded the fetch used its field
    // sort (title) — the toolbar reflects the stored field sort, not Manual.
    expect(router.state.location.search).toEqual({});
    await waitFor(() => expect(documentsUrls.some((u) => u.includes('sort=title'))).toBe(true));
    await waitFor(() => expect(screen.getByText('Title ↑')).toBeInTheDocument());

    // Select Manual via the toolbar. Open the Sort popover, click "Manual".
    await userEvent.click(screen.getByText('Sort:'));
    await userEvent.click(await screen.findByText('Manual'));

    // The ad-hoc override applied without a pinned view: the toolbar now shows
    // Manual, and the board's documents query resolves to board_position order
    // (no `?view=` was ever set — the old gated code would have no-op'd here).
    await waitFor(() => expect(screen.getByText('Manual')).toBeInTheDocument());
    expect(documentsUrls.some((u) => u.includes('sort=board_position'))).toBe(true);
    expect(router.state.location.search).toEqual({});
  });

  // BF2 (2026-05-31): a short column's tinted background stopped at its last
  // card instead of filling the board's full height. The fix relies on the
  // board row stretching each column wrapper (items-stretch + wrapper min-h-0)
  // so the body's flex-1 grows to the row height. Guard the load-bearing
  // class on the body div.
  it('kanban column body stretches to fill height (flex-1)', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      if (u.includes('/statuses')) {
        return new Response(
          JSON.stringify({ data: [{ id: 's1', key: 'todo', name: 'Todo', color: '#6EAFFF', category: 'unstarted', order: 1 }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/documents')) {
        return new Response(
          JSON.stringify({ data: { data: [{ id: 'd1', slug: 'a', type: 'work_item', title: 'Card A', status: 'todo', parentId: null, frontmatter: {}, createdAt: '', updatedAt: new Date().toISOString() }], nextCursor: null } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    const bodies = await screen.findAllByTestId('kanban-column-body');
    expect(bodies.length).toBeGreaterThan(0);
    // The body fills the stretched wrapper via flex-1...
    expect(bodies[0]!.className).toContain('flex-1');
    // ...and the wrapper must be able to stretch within the flex row.
    expect(bodies[0]!.parentElement!.className).toContain('min-h-0');
  });
});
