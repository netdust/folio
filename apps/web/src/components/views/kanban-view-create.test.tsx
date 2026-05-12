import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
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

describe('KanbanView per-column create', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/statuses')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 's1', key: 'backlog', name: 'Backlog', color: '#94a3b8', category: 'backlog', order: 1 },
              { id: 's2', key: 'doing', name: 'In progress', color: '#F0A442', category: 'started', order: 2 },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/documents/') && method === 'PATCH') {
        return new Response(
          JSON.stringify({
            data: { id: 'new', slug: 'untitled-1', type: 'work_item', title: 'Untitled', status: 'backlog', parentId: null, frontmatter: {}, body: '', createdAt: '', updatedAt: '' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/documents') && method === 'POST') {
        return new Response(
          JSON.stringify({
            data: { id: 'new', slug: 'untitled-1', type: 'work_item', title: 'Untitled', status: null, parentId: null, frontmatter: {}, body: '', createdAt: '', updatedAt: '' },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/documents')) {
        return new Response(JSON.stringify({ data: { data: [], nextCursor: null } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('clicking + in the first column creates a doc, patches status, opens slideover', async () => {
    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);

    await screen.findByText('Backlog');
    await userEvent.click(screen.getByRole('button', { name: /New work item in Backlog/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([url, init]) => String(url).match(/\/documents$/) && init?.method === 'POST');
      expect(post).toBeDefined();
    });

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(([url, init]) => String(url).includes('/documents/') && init?.method === 'PATCH');
      expect(patch).toBeDefined();
      const body = JSON.parse(String(patch![1]!.body));
      expect(body.status).toBe('backlog');
    });

    await waitFor(() => expect(router.state.location.search).toEqual({ doc: 'untitled-1' }));
  });
});
