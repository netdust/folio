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

describe('WikiTree DnD', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders wiki tree wrapped in DndContext without crashing', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          data: {
            data: [
              {
                id: 'p1',
                slug: 'intro',
                type: 'page',
                title: 'Introduction',
                status: null,
                parentId: null,
                frontmatter: {},
                createdAt: '',
                updatedAt: '',
              },
              {
                id: 'p2',
                slug: 'getting-started',
                type: 'page',
                title: 'Getting Started',
                status: null,
                parentId: 'p1',
                frontmatter: {},
                createdAt: '',
                updatedAt: '',
              },
            ],
            nextCursor: null,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ));

    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText('Introduction')).toBeInTheDocument());
    // DndContext is transparent — nodes still render and are accessible.
    expect(screen.getByText('Introduction')).toBeInTheDocument();
  });
});
