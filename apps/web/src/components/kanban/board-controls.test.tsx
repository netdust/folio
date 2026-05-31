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
} from '@tanstack/react-router';
import { z } from 'zod';
import { BoardControls } from './board-controls.tsx';
import { boardControlsBus } from '../../lib/board-controls-bus.ts';

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const board = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/board',
    validateSearch: z.object({ doc: z.string().optional() }),
    component: () => {
      const { wslug, pslug } = board.useParams();
      return <BoardControls wslug={wslug} pslug={pslug} tslug="work-items" />;
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([board]),
    history: createMemoryHistory({ initialEntries: ['/w/main/p/web/board'] }),
  });
  return { queryClient, router };
}

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      if (u.includes('/views')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'v1',
                name: 'Board',
                type: 'kanban',
                filters: {},
                sort: null,
                groupBy: null,
                visibleFields: null,
                columnOrder: null,
                isDefault: true,
                order: 1,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/fields')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'f1', key: 'priority', type: 'select', label: 'Priority', options: ['Low', 'High'], required: false, order: 1 },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

describe('BoardControls', () => {
  beforeEach(() => boardControlsBus.reset());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    boardControlsBus.reset();
  });

  it('renders the Group-by + Sort buttons', async () => {
    stubFetch();
    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    expect(await screen.findByText('Group:')).toBeInTheDocument();
    expect(screen.getByText('Sort:')).toBeInTheDocument();
  });

  it('selecting a group-by field writes the override to the bus', async () => {
    stubFetch();
    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    // Wait for the toolbar (and the view) to resolve.
    await screen.findByText('Group:');
    // Open the Group popover, click the Priority field.
    await userEvent.click(screen.getByText('Group:'));
    await userEvent.click(await screen.findByText('Priority'));
    await waitFor(() => expect(boardControlsBus.get('v1')?.groupBy).toBe('priority'));
  });
});
