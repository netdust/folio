import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
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
import { AgentCockpitPanel } from './agent-cockpit-panel.tsx';
import { agentPanelBus } from '../../lib/agent-panel-bus.ts';

// The Activity screen (useActivityFeed) and the run launcher's RunsHistory
// hooks may open an EventSource; jsdom has none, so stub a no-op constructor.
class NoopEventSource {
  constructor(_url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  // The panel's child screens navigate via TanStack hooks (AgentList uses
  // useNavigate). Mount under a memory router with the layout search schema.
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workspace = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug',
    validateSearch: z.object({
      doc: z.string().optional(),
      tab: z.enum(['fields', 'activity', 'runs']).optional(),
    }),
    component: () => <AgentCockpitPanel wslug="main" />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([workspace]),
    history: createMemoryHistory({ initialEntries: ['/w/main'] }),
  });
  return { queryClient, router };
}

async function renderPanel() {
  const { queryClient, router } = setup();
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  // RouterProvider mounts (and thus subscribes the panel to the bus)
  // asynchronously. Wait until the route component is live before driving
  // the bus, otherwise open() fires before the subscription exists.
  await waitFor(() => expect(router.state.isLoading).toBe(false));
}

describe('AgentCockpitPanel', () => {
  beforeEach(() => {
    agentPanelBus.close();
    vi.stubGlobal('EventSource', NoopEventSource as unknown as typeof EventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        async () =>
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
  });
  afterEach(() => {
    agentPanelBus.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders null when the bus is closed', async () => {
    await renderPanel();
    // The PanelHeader Close button is the unambiguous "panel is open" marker.
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('opens on the Run screen when the bus opens to run', async () => {
    await renderPanel();
    act(() => agentPanelBus.open('run'));
    expect(await screen.findByRole('button', { name: 'Close' })).toBeInTheDocument();
    // Run launcher renders its submit button.
    expect(screen.getByRole('button', { name: /Run agent/ })).toBeInTheDocument();
  });

  it('switches to the Activity screen', async () => {
    await renderPanel();
    act(() => agentPanelBus.open('run'));
    expect(await screen.findByRole('button', { name: /Run agent/ })).toBeInTheDocument();

    act(() => agentPanelBus.open('activity'));
    // Empty activity feed shows its placeholder; Run launcher is gone.
    expect(await screen.findByText('No recent agent activity.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Run agent/ })).toBeNull();
  });

  it('closes again when the Close button is clicked', async () => {
    await renderPanel();
    act(() => agentPanelBus.open('activity'));
    const closeBtn = await screen.findByRole('button', { name: 'Close' });
    fireEvent.click(closeBtn);
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });
});
