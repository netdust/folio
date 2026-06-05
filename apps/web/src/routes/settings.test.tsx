import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { Route as InstanceSettingsRoute } from './settings.tsx';
import * as auth from '../lib/api/auth.ts';

const InstanceSettingsPage = InstanceSettingsRoute.options.component!;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// The page renders a TanStack <Link> (System Library → __system agents) + the
// AiTab (which fetches instance keys), so mount under a memory router + stub fetch.
function renderPage(qc: QueryClient) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { keys: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <InstanceSettingsPage />,
  });
  const agentsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/agents',
    component: () => <div>agents page</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, agentsRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('Instance settings page', () => {
  it('shows the AI provider section to an instance admin', async () => {
    vi.spyOn(auth, 'useIsInstanceAdmin').mockReturnValue(true);
    vi.spyOn(auth, 'useIsSystemMember').mockReturnValue(true);
    renderPage(newQc());
    expect(await screen.findByText(/instance settings/i)).toBeInTheDocument();
    // AiTab's heading.
    expect(await screen.findByText(/AI Provider/i)).toBeInTheDocument();
  });

  it('hides the AI provider section from a non-admin', async () => {
    vi.spyOn(auth, 'useIsInstanceAdmin').mockReturnValue(false);
    vi.spyOn(auth, 'useIsSystemMember').mockReturnValue(true);
    renderPage(newQc());
    expect(await screen.findByText(/instance settings/i)).toBeInTheDocument();
    expect(screen.queryByText(/AI Provider/i)).not.toBeInTheDocument();
  });

  it('links the System Library entry to the __system agents page (system member)', async () => {
    vi.spyOn(auth, 'useIsInstanceAdmin').mockReturnValue(false);
    vi.spyOn(auth, 'useIsSystemMember').mockReturnValue(true);
    renderPage(newQc());
    const link = await screen.findByRole('link', { name: /system library/i });
    expect(link).toHaveAttribute('href', '/w/__system/agents');
  });

  it('shows a no-access state to a plain user (no instance surfaces)', async () => {
    vi.spyOn(auth, 'useIsInstanceAdmin').mockReturnValue(false);
    vi.spyOn(auth, 'useIsSystemMember').mockReturnValue(false);
    renderPage(newQc());
    expect(await screen.findByText(/don't have access/i)).toBeInTheDocument();
    expect(screen.queryByText(/system library/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/AI Provider/i)).not.toBeInTheDocument();
  });
});
