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

// BF5 (2026-05-31): the shared-view-id contract depends on BoardControls
// (tab-row WRITER) and KanbanView (board-body READER) resolving the SAME
// `activeView.id` so they share a bus key. The other tests drive the bus
// directly (e.g. `boardControlsBus.setSort('v1', …)`), which can't catch an id
// divergence between the two components. This TRUE integration test mounts BOTH
// against one router + QueryClient with NO `?view=` (so both resolve the
// DEFAULT view), picks a FIELD sort ("Priority") in BoardControls' Sort menu,
// and asserts KanbanView refetches `/documents` with `sort=priority`. The
// refetch only fires if both components agree on the id (`v-default`).
//
// (Manual/board_position drag-sort is PARKED — the Sort menu no longer offers
// a "Manual" item — so this exercises the same cross-component contract via a
// still-live FIELD sort instead of the parked null sort.)
//
// The default view ships a FIELD sort (`updated_at`), so the board starts on a
// DIFFERENT field. We assert on OBSERVABLE BOARD CONTENT rather than on a
// network call: the `/documents` stub returns a DIFFERENT card depending on
// the `sort=` param ("Updated card" for `sort=updated_at`, "Priority card" for
// `sort=priority`). After clicking Priority, the board must swap to the
// priority card — which only happens if KanbanView re-derived its documents
// query under the SAME view id BoardControls wrote the override to
// (`v-default`). This is robust against react-query cache hits: asserting on
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

  test('clicking a field sort in the tab-row controls switches the board to that field (shared view id)', async () => {
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
          const isPriority = u.includes('sort=priority');
          const card = isPriority
            ? { id: 'd-priority', slug: 'p', title: 'Priority card' }
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

    // Open the Sort menu in BoardControls (the tab-row controls) and pick the
    // "Priority" field sort. Only BoardControls renders a Sort button now —
    // KanbanView's toolbar was removed — so getByRole is unambiguous.
    expect(screen.getAllByRole('button', { name: /sort/i })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /sort/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /priority/i }));

    // The board must swap to the sort=priority documents — the "Priority card".
    // This only happens if BoardControls wrote the field-sort override under the
    // SAME view id KanbanView reads (`v-default`): BoardControls is the WRITER,
    // KanbanView the READER, and they share the bus key. An id divergence =
    // KanbanView never switches its query = this assertion times out.
    await screen.findByText('Priority card');
    expect(screen.queryByText('Updated card')).not.toBeInTheDocument();
    // Belt-and-suspenders: the sort=priority query was indeed requested.
    expect(calls.some((u) => u.includes('/documents') && u.includes('sort=priority'))).toBe(true);
  });
});
