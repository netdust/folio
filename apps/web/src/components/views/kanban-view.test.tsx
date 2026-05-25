import { describe, it, expect, afterEach, vi } from 'vitest';
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

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const board = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/board',
    validateSearch: z.object({ doc: z.string().optional() }),
    component: () => {
      const { wslug, pslug } = board.useParams();
      return <KanbanView wslug={wslug} pslug={pslug} />;
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([board]),
    history: createMemoryHistory({ initialEntries: ['/w/main/p/web/board'] }),
  });
  return { queryClient, router };
}

describe('KanbanView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
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
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
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
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    await userEvent.click(await screen.findByText('Card A'));
    await waitFor(() => expect(router.state.location.search).toEqual({ doc: 'a' }));
  });
});
