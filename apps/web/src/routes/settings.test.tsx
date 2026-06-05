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

// The page mounts AiTab + RolesTab + InvitationsTab, which fetch instance keys /
// users / invite-targets / grants. Stub fetch to a benign empty payload for all.
function renderPage(qc: QueryClient) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: { keys: [], users: [], workspaces: [], projects: [], grants: [] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ),
  );
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <InstanceSettingsPage />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
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
  it('shows AI, Roles, and Invitations sections to an instance admin', async () => {
    vi.spyOn(auth, 'useIsInstanceAdmin').mockReturnValue(true);
    vi.spyOn(auth, 'useIsInstanceOwner').mockReturnValue(true);
    renderPage(newQc());
    expect(await screen.findByText(/instance settings/i)).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: /^AI providers$/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Roles$/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Invitations$/i })).toBeInTheDocument();
  });

  it('shows a no-access state to a non-admin (no instance surfaces)', async () => {
    vi.spyOn(auth, 'useIsInstanceAdmin').mockReturnValue(false);
    vi.spyOn(auth, 'useIsInstanceOwner').mockReturnValue(false);
    renderPage(newQc());
    expect(await screen.findByText(/don't have access/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^AI providers$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^Roles$/i })).not.toBeInTheDocument();
    // The dead __system "System Library" entry is gone.
    expect(screen.queryByText(/system library/i)).not.toBeInTheDocument();
  });
});
