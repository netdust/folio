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

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const work = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/work-items',
    validateSearch: z.object({ doc: z.string().optional() }),
    component: () => {
      const { wslug, pslug } = work.useParams();
      return <ListView wslug={wslug} pslug={pslug} />;
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([work]),
    history: createMemoryHistory({ initialEntries: ['/w/main/p/web/work-items'] }),
  });
  return { queryClient, router };
}

const docRow = {
  id: 'd1',
  slug: 'fix-login',
  type: 'work_item' as const,
  title: 'Fix login bug',
  status: 'todo' as string | null,
  parentId: null,
  frontmatter: {},
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: new Date().toISOString(),
};

describe('ListView inline-edit', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('committing a new title fires PATCH', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
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
      if (u.includes('/fields')) {
        return new Response(
          JSON.stringify({ data: [] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(
          JSON.stringify({ data: { data: [docRow], nextCursor: null } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/documents/fix-login') && method === 'PATCH') {
        return new Response(
          JSON.stringify({ data: { ...docRow, title: 'Fix login (revised)' } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByText('Fix login bug'));
    const input = await screen.findByRole('textbox', { name: 'Edit title: Fix login bug' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Fix login (revised){Enter}');

    await waitFor(() => {
      const patches = fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).includes('/documents/fix-login') && init?.method === 'PATCH',
      );
      expect(patches).toHaveLength(1);
      const body = JSON.parse(String(patches[0]?.[1]?.body));
      expect(body).toEqual({ title: 'Fix login (revised)' });
    });
  });

  it('rolls back on PATCH error', async () => {
    let getCalls = 0;
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
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
      if (u.includes('/fields')) {
        return new Response(
          JSON.stringify({ data: [] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/documents') && method === 'GET') {
        getCalls += 1;
        return new Response(
          JSON.stringify({ data: { data: [docRow], nextCursor: null } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/documents/fix-login') && method === 'PATCH') {
        return new Response(
          JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await userEvent.click(await screen.findByText('Fix login bug'));
    const input = await screen.findByRole('textbox', { name: 'Edit title: Fix login bug' });
    await userEvent.clear(input);
    await userEvent.type(input, 'broken{Enter}');

    // After settle + invalidation, the original title is back
    await waitFor(() => expect(screen.getByText('Fix login bug')).toBeInTheDocument());
    expect(getCalls).toBeGreaterThan(1); // proves invalidation re-fetched
  });
});
