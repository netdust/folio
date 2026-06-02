import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { WorkspacePicker } from './workspace-picker.tsx';
import { SYSTEM_WORKSPACE_SLUG } from '../lib/api/workspaces.ts';

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
    component: () => <div>workspace page</div>,
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, workspaceRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });

  return { router, queryClient };
}

describe('WorkspacePicker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
      expect(screen.getByText('workspace page')).toBeInTheDocument(),
    );
  });

  it('renders a card grid when there are multiple workspaces', async () => {
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

    await waitFor(() => expect(screen.getByText('Acme')).toBeInTheDocument());
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.getByText('/acme')).toBeInTheDocument();
    expect(screen.getByText('/beta')).toBeInTheDocument();
  });

  // Phase D D1 — the picker never lists the reserved `__system` library
  // workspace. The real feeder, `useWorkspaces()`, is server-filtered as of
  // Task 1 (commit bd1e631) so `__system` never reaches the client: this pins
  // that the picker renders exactly the memberships it is given (no `__system`
  // row materializes from the server-filtered list).
  it('D1: does not list the reserved __system workspace (mirrors the server-filtered feed)', async () => {
    // The server filter strips `__system`, so the client receives only real
    // member workspaces.
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

    await waitFor(() => expect(screen.getByText('Acme')).toBeInTheDocument());
    // No __system entry — neither by name nor by its `/__system` slug line.
    expect(screen.queryByText('/__system')).not.toBeInTheDocument();
    expect(screen.queryByText(SYSTEM_WORKSPACE_SLUG)).not.toBeInTheDocument();
    // Exactly the two member workspaces rendered.
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });
});
