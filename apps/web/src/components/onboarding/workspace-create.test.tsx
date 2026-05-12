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
import { WorkspaceCreate } from './workspace-create.tsx';

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <WorkspaceCreate open onOpenChange={() => {}} />,
  });
  const w = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug',
    component: () => <div>navigated to workspace</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([home, w]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return { queryClient, router };
}

describe('WorkspaceCreate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('auto-derives slug from name and submits to create the workspace', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (String(url).endsWith('/api/v1/workspaces') && init?.method === 'POST') {
          return new Response(
            JSON.stringify({
              data: { id: 'w1', slug: 'spring-show', name: 'Spring Show' },
            }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );

    const { queryClient, router } = setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const nameInput = await screen.findByLabelText(/Name/);
    await userEvent.type(nameInput, 'Spring Show');
    // Slug should auto-derive
    await waitFor(() => {
      expect(screen.getByLabelText(/Slug/)).toHaveValue('spring-show');
    });
    await userEvent.click(screen.getByRole('button', { name: /Create workspace/ }));
    await waitFor(() => expect(screen.getByText('navigated to workspace')).toBeInTheDocument());
  });

  it('surfaces SLUG_TAKEN as an inline field error, not a toast', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: { code: 'SLUG_CONFLICT', message: 'Slug already in use' } }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const { queryClient, router } = setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const nameInput = await screen.findByLabelText(/Name/);
    await userEvent.type(nameInput, 'Spring');
    await userEvent.click(screen.getByRole('button', { name: /Create workspace/ }));
    await waitFor(() =>
      expect(screen.getByText(/already in use|already taken|Slug already/i)).toBeInTheDocument(),
    );
  });
});
