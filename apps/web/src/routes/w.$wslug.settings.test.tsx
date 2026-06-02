import { describe, expect, it, vi, afterEach } from 'vitest';
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
import type { ReactNode } from 'react';
import { SettingsPage } from './w.$wslug.settings.tsx';
import * as auth from '../lib/api/auth.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function stubFetch(map: Record<string, () => Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      for (const [match, build] of Object.entries(map)) {
        if (url.includes(match)) return build();
      }
      return new Response(JSON.stringify({ data: { tokens: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

describe('SettingsPage', () => {
  it('renders the page title and the Tokens tab content', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubFetch({
      '/api/v1/w/acme': () =>
        new Response(
          JSON.stringify({
            data: {
              id: 'ws-1',
              slug: 'acme',
              name: 'Acme',
              role: 'owner',
              createdAt: '2026-05-25T00:00:00.000Z',
              updatedAt: '2026-05-25T00:00:00.000Z',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    render(<SettingsPage wslug="acme" />, { wrapper: wrap(qc) });

    expect(await screen.findByText(/workspace settings/i)).toBeInTheDocument();
    // Tokens tab is the only one for now and is selected by default
    expect(await screen.findByText(/api tokens/i)).toBeInTheDocument();
  });

  it('shows a "Settings" link in the breadcrumb / heading for the active workspace', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubFetch({
      '/api/v1/w/acme': () =>
        new Response(
          JSON.stringify({
            data: {
              id: 'ws-1',
              slug: 'acme',
              name: 'Acme',
              role: 'owner',
              createdAt: '2026-05-25T00:00:00.000Z',
              updatedAt: '2026-05-25T00:00:00.000Z',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    render(<SettingsPage wslug="acme" />, { wrapper: wrap(qc) });
    expect(await screen.findByText('Acme')).toBeInTheDocument();
  });
});

// D2: the System Library entry needs a router context because it renders a
// TanStack <Link>. Mount SettingsPage under a memory router whose route tree
// declares the `/w/$wslug/agents` target so the Link resolves to a real href.
function renderWithRouter(qc: QueryClient) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <SettingsPage wslug="acme" />,
  });
  const agentsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/agents',
    component: () => <div>agents page</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([settingsRoute, agentsRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('SettingsPage — System Library (D2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function stubWorkspace() {
    stubFetch({
      '/api/v1/w/acme': () =>
        new Response(
          JSON.stringify({
            data: {
              id: 'ws-1',
              slug: 'acme',
              name: 'Acme',
              role: 'owner',
              createdAt: '2026-05-25T00:00:00.000Z',
              updatedAt: '2026-05-25T00:00:00.000Z',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });
  }

  it('shows a System Library entry only to a __system member', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubWorkspace();
    vi.spyOn(auth, 'useIsSystemMember').mockReturnValue(true);

    renderWithRouter(qc);

    expect(
      await screen.findByRole('heading', { name: /system library/i }),
    ).toBeInTheDocument();
  });

  it('hides the System Library entry from a non-member', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubWorkspace();
    vi.spyOn(auth, 'useIsSystemMember').mockReturnValue(false);

    renderWithRouter(qc);

    // Wait for the page to settle, then assert the entry is absent.
    expect(await screen.findByText(/workspace settings/i)).toBeInTheDocument();
    expect(screen.queryByText(/system library/i)).not.toBeInTheDocument();
  });

  it('links the System Library entry to the __system agents page', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubWorkspace();
    vi.spyOn(auth, 'useIsSystemMember').mockReturnValue(true);

    renderWithRouter(qc);

    const link = await screen.findByRole('link', { name: /system library/i });
    expect(link).toHaveAttribute('href', '/w/__system/agents');
  });
});
