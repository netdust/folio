import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  RouterProvider,
} from '@tanstack/react-router';
import { ApiError, client as api } from '../lib/api/client.ts';
import { authKeys, type SessionUser } from '../lib/api/auth.ts';

interface Ctx {
  queryClient: QueryClient;
}

function makeRouter(initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const PUBLIC = new Set(['/login']);
  const rootRoute = createRootRouteWithContext<Ctx>()({
    beforeLoad: async ({ context, location }) => {
      if (PUBLIC.has(location.pathname)) return;
      try {
        await context.queryClient.fetchQuery({
          queryKey: authKeys.me,
          queryFn: () => api.get<{ user: SessionUser }>('/api/v1/auth/me'),
        });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          throw redirect({ to: '/login', search: { redirect: location.href } });
        }
        throw err;
      }
    },
    component: () => <Outlet />,
  });
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <div>home</div>,
  });
  const login = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: () => <div>login page</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([home, login]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    context: { queryClient },
  });
  return { router, queryClient };
}

describe('root auth gate', () => {
  afterEach(() => vi.restoreAllMocks());

  it('allows public paths without /me check', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const { router, queryClient } = makeRouter('/login');

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('login page')).toBeInTheDocument());
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('redirects to /login when /me returns 401', async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'no session' } }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;

    const { router, queryClient } = makeRouter('/');

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('login page')).toBeInTheDocument());
  });

  it('renders the home outlet when /me returns 200', async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ data: { user: { id: 'u1', email: 'a@b.c', name: 'A' } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;

    const { router, queryClient } = makeRouter('/');

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('home')).toBeInTheDocument());
  });
});
