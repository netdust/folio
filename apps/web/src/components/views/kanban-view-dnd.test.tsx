import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
});
