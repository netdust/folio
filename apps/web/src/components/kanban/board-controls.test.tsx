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
  const fn = vi.fn<typeof fetch>(async (url) => {
    {
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
    }
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

// Finds the PATCH call to the active view (the persist write), or undefined.
function findViewPatch(fetchMock: ReturnType<typeof vi.fn>, viewId = 'v1') {
  return fetchMock.mock.calls.find(
    ([url, init]) =>
      String(url).includes(`/views/${viewId}`) && (init as RequestInit | undefined)?.method === 'PATCH',
  ) as [string, RequestInit] | undefined;
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

  // 4b: on the seeded DEFAULT board (no `?view=`), the active view IS the user's
  // real working view, so a group-by change must PERSIST to it — not just live in
  // the bus and vanish on reload. Previously the persist was gated behind
  // ?view=<id> so this PATCH never fired on the default board.
  it('persists a group-by change to the default view even without ?view= (PATCH fires)', async () => {
    const fetchMock = stubFetch();
    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    await screen.findByText('Group:');
    // No ?view= in the URL — the default board.
    expect(router.state.location.search).toEqual({});
    await userEvent.click(screen.getByText('Group:'));
    await userEvent.click(await screen.findByText('Priority'));
    // The bus update is the live UI (already asserted above); the NEW behavior is
    // that the change is ALSO written to the active view.
    await waitFor(() => {
      const patch = findViewPatch(fetchMock);
      expect(patch).toBeDefined();
      expect(JSON.parse(patch![1].body as string)).toEqual({ groupBy: 'priority' });
    });
  });

  // 4b: a Sort change on the default board persists too — the sort JSON array is
  // written to the active view.
  it('persists a sort change to the default view even without ?view=', async () => {
    const fetchMock = stubFetch();
    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    await screen.findByText('Sort:');
    expect(router.state.location.search).toEqual({});
    await userEvent.click(screen.getByText('Sort:'));
    await userEvent.click(await screen.findByText('Title'));
    await waitFor(() => {
      const patch = findViewPatch(fetchMock);
      expect(patch).toBeDefined();
      expect(JSON.parse(patch![1].body as string)).toEqual({ sort: [{ key: 'title', dir: 'asc' }] });
    });
  });
});
