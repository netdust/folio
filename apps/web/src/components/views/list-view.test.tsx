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
import { ListView } from './list-view.tsx';

function setup(initialPath = '/w/main/p/web/work-items') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const work = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/work-items',
    validateSearch: z.object({ doc: z.string().optional() }),
    component: () => {
      const { wslug, pslug } = work.useParams();
      return <ListView wslug={wslug} pslug={pslug} tslug="work-items" />;
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([work]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  return { queryClient, router };
}

function mockResponse(url: string) {
  if (url.includes('/documents?') || url.endsWith('/documents')) {
    return new Response(
      JSON.stringify({
        data: {
          data: [
            {
              id: 'd1',
              slug: 'fix-login',
              type: 'work_item',
              title: 'Fix login bug',
              status: 'todo',
              parentId: null,
              frontmatter: {},
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: new Date().toISOString(),
            },
          ],
          nextCursor: null,
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  if (url.includes('/statuses')) {
    return new Response(
      JSON.stringify({
        data: [
          { id: 's1', key: 'todo', name: 'Todo', color: '#6EAFFF', category: 'unstarted', order: 1 },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  if (url.includes('/fields')) {
    return new Response(
      JSON.stringify({ data: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('ListView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders rows from the documents endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => mockResponse(String(url)));
    vi.stubGlobal('fetch', fetchMock);
    const { queryClient, router } = setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('Fix login bug')).toBeInTheDocument());
    expect(screen.getByText('Todo')).toBeInTheDocument();
  });

  it('renders empty state when no documents', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('/documents')) {
        return new Response(JSON.stringify({ data: { data: [], nextCursor: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return mockResponse(String(url));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { queryClient, router } = setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText(/No work items/)).toBeInTheDocument());
  });

  it('clicking the open icon updates the URL with ?doc=', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => mockResponse(String(url)));
    vi.stubGlobal('fetch', fetchMock);
    const { queryClient, router } = setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Fix login bug');
    await userEvent.click(screen.getByRole('button', { name: 'Open Fix login bug' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ doc: 'fix-login' }));
  });
});
