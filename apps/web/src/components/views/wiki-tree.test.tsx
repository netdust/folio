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
import { WikiTree } from './wiki-tree.tsx';

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const wiki = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/wiki',
    validateSearch: z.object({ doc: z.string().optional() }),
    component: () => {
      const { wslug, pslug } = wiki.useParams();
      return <WikiTree wslug={wslug} pslug={pslug} />;
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([wiki]),
    history: createMemoryHistory({ initialEntries: ['/w/main/p/web/wiki'] }),
  });
  return { queryClient, router };
}

function pagesResponse(items: Array<{ id: string; slug: string; title: string; parentId?: string | null }>) {
  return new Response(
    JSON.stringify({
      data: {
        data: items.map((i) => ({
          id: i.id, slug: i.slug, type: 'page', title: i.title,
          status: null, parentId: i.parentId ?? null,
          frontmatter: {}, createdAt: '', updatedAt: '',
        })),
        nextCursor: null,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('WikiTree', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders nested pages and toggles children visibility', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => pagesResponse([
      { id: 'a', slug: 'a', title: 'Parent' },
      { id: 'b', slug: 'b', title: 'Child', parentId: 'a' },
    ])));

    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText('Parent')).toBeInTheDocument());
    expect(screen.queryByText('Child')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Expand Parent/ }));
    expect(screen.getByText('Child')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Collapse Parent/ }));
    expect(screen.queryByText('Child')).not.toBeInTheDocument();
  });

  it('clicking a node sets ?doc=', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => pagesResponse([
      { id: 'a', slug: 'a', title: 'Parent' },
    ])));

    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    await userEvent.click(await screen.findByText('Parent'));
    await waitFor(() => expect(router.state.location.search).toEqual({ doc: 'a' }));
  });

  it('empty state offers New page', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/documents') && method === 'POST') {
        return new Response(
          JSON.stringify({
            data: { id: 'new', slug: 'untitled', type: 'page', title: 'Untitled', status: null, parentId: null, frontmatter: {}, body: '', createdAt: '', updatedAt: '' },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      return pagesResponse([]);
    }));

    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText('No pages yet')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Create your first page' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ doc: 'untitled' }));
  });
});
