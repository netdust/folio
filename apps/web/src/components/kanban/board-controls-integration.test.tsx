import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
import { BoardControls } from './board-controls.tsx';
import { KanbanView } from '../views/kanban-view.tsx';
import { boardControlsBus } from '../../lib/board-controls-bus.ts';

// BF5 (2026-05-31): Manual mode depends on BoardControls (tab-row WRITER) and
// KanbanView (board-body READER) resolving the SAME `activeView.id` so they
// share a bus key. The other tests drive the bus directly (e.g.
// `boardControlsBus.setSort('v1', null)`), which can't catch an id divergence
// between the two components. This TRUE integration test mounts BOTH against
// one router + QueryClient with NO `?view=` (so both resolve the DEFAULT view),
// clicks "Manual" in BoardControls' Sort menu, and asserts KanbanView refetches
// `/documents` with `sort=board_position`. The refetch only fires if both
// components agree on the id (`v-default`).
//
// The default view ships a FIELD sort (`updated_at`), so the board starts
// non-manual. We assert on OBSERVABLE BOARD CONTENT rather than on a network
// call: the `/documents` stub returns a DIFFERENT card depending on the
// `sort=` param ("Updated card" for `sort=updated_at`, "Manual card" for
// `sort=board_position`). After clicking Manual, the board must swap to the
// board_position card — which only happens if KanbanView re-derived its
// documents query under the SAME view id BoardControls wrote the override to
// (`v-default`). This is robust against react-query cache hits (the prior
// task hit flakiness asserting on the raw fetch: react-query can serve
// `board_position` from a cache entry warmed during the brief pre-view
// loading window, so no NEW network call fires on the click). Asserting on
// rendered content proves the read/write share the id regardless of cache.

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const board = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/board',
    validateSearch: z.object({ doc: z.string().optional(), view: z.string().optional() }),
    // Mount BOTH components in the same tree, just like the real Board tab:
    // BoardControls in the tab row, KanbanView as the body.
    component: () => {
      const { wslug, pslug } = board.useParams();
      return (
        <>
          <BoardControls wslug={wslug} pslug={pslug} tslug="work-items" />
          <KanbanView wslug={wslug} pslug={pslug} tslug="work-items" />
        </>
      );
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([board]),
    history: createMemoryHistory({ initialEntries: ['/w/main/p/web/board'] }),
  });
  return { queryClient, router };
}

describe('BoardControls + KanbanView integration', () => {
  beforeEach(() => boardControlsBus.reset());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    boardControlsBus.reset();
  });

  test('clicking Manual in the tab-row controls switches the board to board_position order', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (url) => {
        const u = String(url);
        calls.push(u);
        if (u.includes('/statuses')) {
          return new Response(
            JSON.stringify({
              data: [{ id: 's1', key: 'todo', name: 'Todo', color: '#6EAFFF', category: 'unstarted', order: 1 }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (u.includes('/views')) {
          // DEFAULT view (no ?view= in the URL), with a FIELD sort so the board
          // starts non-manual. Both components must resolve THIS id (v-default).
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: 'v-default',
                  name: 'Board',
                  type: 'kanban',
                  filters: {},
                  sort: [{ key: 'updated_at', dir: 'desc' }],
                  groupBy: null,
                  visibleFields: null,
                  columnOrder: null,
                  isDefault: true,
                  order: 0,
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
          // Return a DIFFERENT card per sort so the board's content is an
          // observable signal of which documents query is active.
          const isManual = u.includes('sort=board_position');
          const card = isManual
            ? { id: 'd-manual', slug: 'm', title: 'Manual card' }
            : { id: 'd-updated', slug: 'u', title: 'Updated card' };
          return new Response(
            JSON.stringify({
              data: {
                data: [
                  { ...card, type: 'work_item', status: 'todo', parentId: null, frontmatter: {}, createdAt: '', updatedAt: new Date().toISOString() },
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
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    // Once the view resolves the board shows the `sort=updated_at` documents,
    // i.e. the non-manual "Updated card". The view loaded with NO `?view=`.
    await screen.findByText('Updated card');
    expect(calls.some((u) => u.includes('/documents') && u.includes('sort=updated_at'))).toBe(true);
    expect(router.state.location.search).toEqual({});

    // Open the Sort menu in BoardControls (the tab-row controls) and pick
    // Manual. Only BoardControls renders a Sort button now — KanbanView's
    // toolbar was removed — so getByRole is unambiguous.
    expect(screen.getAllByRole('button', { name: /sort/i })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /sort/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /manual/i }));

    // The board must swap to the board_position documents — the "Manual card".
    // This only happens if BoardControls wrote the null-sort override under the
    // SAME view id KanbanView reads (`v-default`): BoardControls is the WRITER,
    // KanbanView the READER, and they share the bus key. An id divergence =
    // KanbanView never switches its query = this assertion times out.
    await screen.findByText('Manual card');
    expect(screen.queryByText('Updated card')).not.toBeInTheDocument();
    // Belt-and-suspenders: the board_position query was indeed requested.
    expect(calls.some((u) => u.includes('/documents') && u.includes('sort=board_position'))).toBe(true);
  });
});
