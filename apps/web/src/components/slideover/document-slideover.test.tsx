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
import { DocumentSlideover } from './document-slideover.tsx';

function setup(initialSearch: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const project = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug',
    validateSearch: z.object({ doc: z.string().optional() }),
    component: () => {
      const { wslug, pslug } = project.useParams();
      return (
        <>
          <div>project body</div>
          <DocumentSlideover wslug={wslug} pslug={pslug} />
        </>
      );
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([project]),
    history: createMemoryHistory({ initialEntries: [`/w/main/p/web${initialSearch}`] }),
  });
  return { queryClient, router };
}

function mockDoc(slug: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes(`/documents/${slug}`)) {
        return new Response(
          JSON.stringify({
            data: {
              id: 'd1',
              slug,
              type: 'work_item',
              title: 'Fix login bug',
              status: 'todo',
              parentId: null,
              frontmatter: {},
              body: '# Steps\n\n1. Reproduce',
              createdAt: '2026-01-01',
              updatedAt: '2026-01-02',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (String(url).includes('/statuses')) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url).includes('/fields')) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

describe('DocumentSlideover', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('is closed by default (no ?doc=)', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>());
    const { queryClient, router } = setup('');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('project body')).toBeInTheDocument());
    expect(screen.queryByText('Fix login bug')).not.toBeInTheDocument();
  });

  it('opens and fetches when ?doc= is set', async () => {
    mockDoc('fix-login');
    const { queryClient, router } = setup('?doc=fix-login');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('Fix login bug')).toBeInTheDocument());
    expect(screen.getByText(/Reproduce/)).toBeInTheDocument();
  });

  it('clicking close removes ?doc= from the URL', async () => {
    mockDoc('fix-login');
    const { queryClient, router } = setup('?doc=fix-login');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Fix login bug');
    await userEvent.click(screen.getByRole('button', { name: /Close document/ }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });
});
