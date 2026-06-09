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
import { ListView } from './list-view.tsx';

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
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
    history: createMemoryHistory({ initialEntries: ['/w/main/p/web/work-items'] }),
  });
  return { queryClient, router };
}

describe('ListView New work item action', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/documents') && method === 'POST') {
        return new Response(
          JSON.stringify({
            data: { id: 'new', slug: 'untitled-1', type: 'work_item', title: 'Untitled', status: null, parentId: null, frontmatter: {}, body: '', createdAt: '', updatedAt: '' },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/statuses')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/fields')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/documents') && method === 'GET') {
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

  it('clicking "New work item" fires POST and opens the slideover for the created doc', async () => {
    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);

    await userEvent.click(await screen.findByRole('button', { name: /Create your first work item/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([url, init]) => String(url).includes('/documents') && init?.method === 'POST');
      expect(post).toBeDefined();
      const body = JSON.parse(String(post![1]!.body));
      expect(body.type).toBe('work_item');
      expect(body.title).toBe('Untitled');
    });

    await waitFor(() => expect(router.state.location.search).toEqual({ doc: 'untitled-1' }));
  });
});
