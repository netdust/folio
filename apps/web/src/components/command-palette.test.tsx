import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { CommandPalette } from './command-palette.tsx';

// cmdk uses ResizeObserver and scrollIntoView internally; jsdom doesn't implement them.
beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

function setup(initialPath: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <Outlet />
        <CommandPalette />
      </>
    ),
  });
  const workItemsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/work-items',
    component: () => <div>work items page</div>,
  });
  const wikiRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/wiki',
    component: () => <div>wiki page</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([workItemsRoute, wikiRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  return { queryClient, router };
}

function mockFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      if (u.includes('/workspaces')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                workspace: {
                  id: 'w1',
                  slug: 'main',
                  name: 'Main',
                  createdAt: '',
                  updatedAt: '',
                },
                role: 'owner',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/projects')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'p1',
                workspaceId: 'w1',
                slug: 'web',
                name: 'Web',
                icon: null,
                description: null,
                archivedAt: null,
                createdAt: '',
                updatedAt: '',
              },
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
                  slug: 'fix',
                  type: 'work_item',
                  title: 'Fix login bug',
                  status: null,
                  parentId: null,
                  frontmatter: {},
                  createdAt: '',
                  updatedAt: '',
                },
              ],
              nextCursor: null,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

describe('CommandPalette', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens with Cmd-K and shows the Tools group', async () => {
    mockFetch();
    const { queryClient, router } = setup('/w/main/p/web/work-items');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('work items page');
    // jsdom's navigator.platform is empty → getKeyMod() returns 'ctrlKey'
    await userEvent.keyboard('{Control>}k{/Control}');
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Type a command…')).toBeInTheDocument(),
    );
    expect(screen.getByText('Toggle theme')).toBeInTheDocument();
  });

  it('filters items by query — typing "theme" hides "New work item"', async () => {
    mockFetch();
    const { queryClient, router } = setup('/w/main/p/web/work-items');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('work items page');
    // jsdom's navigator.platform is empty → getKeyMod() returns 'ctrlKey'
    await userEvent.keyboard('{Control>}k{/Control}');
    const input = await screen.findByPlaceholderText('Type a command…');
    await userEvent.type(input, 'theme');
    expect(screen.getByText('Toggle theme')).toBeInTheDocument();
    expect(screen.queryByText('New work item')).not.toBeInTheDocument();
  });

  it('Open document group lists project documents and routes on select', async () => {
    mockFetch();
    const { queryClient, router } = setup('/w/main/p/web/work-items');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('work items page');
    // jsdom's navigator.platform is empty → getKeyMod() returns 'ctrlKey'
    await userEvent.keyboard('{Control>}k{/Control}');
    await userEvent.click(await screen.findByText('Fix login bug'));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({ doc: 'fix' }),
    );
  });
});
