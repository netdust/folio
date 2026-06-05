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
  useParams,
} from '@tanstack/react-router';
import { WorkspacePicker } from './workspace-picker.tsx';
import { setLastWorkspaceSlug } from '../lib/last-workspace.ts';

function mockWorkspaces(items: { id: string; slug: string; name: string }[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: items.map((i) => ({
            workspace: {
              id: i.id,
              slug: i.slug,
              name: i.name,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
            role: 'owner',
          })),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ),
  );
}

function makeRouter(onCreate: () => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <WorkspacePicker onCreate={onCreate} />,
  });
  const workspaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug',
    // Render the slug so tests can assert WHICH workspace it landed on.
    component: function WorkspacePage() {
      const { wslug } = useParams({ strict: false }) as { wslug: string };
      return <div>workspace page: {wslug}</div>;
    },
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, workspaceRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });

  return { router, queryClient };
}

describe('WorkspacePicker', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('shows empty state and calls onCreate when button is clicked', async () => {
    mockWorkspaces([]);
    const onCreate = vi.fn();
    const { router, queryClient } = makeRouter(onCreate);

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /create workspace/i })).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByRole('button', { name: /create workspace/i }));
    expect(onCreate).toHaveBeenCalledOnce();
  });

  it('auto-redirects to /w/:wslug when there is exactly one workspace', async () => {
    mockWorkspaces([{ id: 'ws-1', slug: 'acme', name: 'Acme' }]);
    const { router, queryClient } = makeRouter(vi.fn());

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText('workspace page: acme')).toBeInTheDocument(),
    );
  });

  it('redirects to the FIRST workspace when nothing was last opened', async () => {
    mockWorkspaces([
      { id: 'ws-1', slug: 'acme', name: 'Acme' },
      { id: 'ws-2', slug: 'beta', name: 'Beta' },
    ]);
    const { router, queryClient } = makeRouter(vi.fn());

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText('workspace page: acme')).toBeInTheDocument(),
    );
    // The all-workspaces grid is gone — no "Your workspaces" heading.
    expect(screen.queryByText(/your workspaces/i)).not.toBeInTheDocument();
  });

  it('redirects to the LAST-OPENED workspace when one is remembered', async () => {
    setLastWorkspaceSlug('beta');
    mockWorkspaces([
      { id: 'ws-1', slug: 'acme', name: 'Acme' },
      { id: 'ws-2', slug: 'beta', name: 'Beta' },
    ]);
    const { router, queryClient } = makeRouter(vi.fn());

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText('workspace page: beta')).toBeInTheDocument(),
    );
  });

  it('falls back to the first workspace when the remembered one is gone', async () => {
    setLastWorkspaceSlug('deleted-ws');
    mockWorkspaces([
      { id: 'ws-1', slug: 'acme', name: 'Acme' },
      { id: 'ws-2', slug: 'beta', name: 'Beta' },
    ]);
    const { router, queryClient } = makeRouter(vi.fn());

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText('workspace page: acme')).toBeInTheDocument(),
    );
  });
});
