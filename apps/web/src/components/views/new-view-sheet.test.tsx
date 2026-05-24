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
import { NewViewSheet } from './new-view-sheet.tsx';

interface SetupOpts {
  currentSearch?: Record<string, unknown>;
}

function setup({ currentSearch }: SetupOpts = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <NewViewSheet
        open
        onOpenChange={() => {}}
        wslug="main"
        pslug="acme"
        currentSearch={currentSearch}
      />
    ),
  });
  const workItems = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/work-items',
    component: () => <div>navigated to work-items</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([home, workItems]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return { queryClient, router };
}

function mockFetch(viewId = 'v-new') {
  return vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/api/v1/w/main/p/acme/views') && init?.method === 'POST') {
      return new Response(
        JSON.stringify({
          data: {
            id: viewId,
            name: 'X',
            type: 'list',
            filters: {},
            sort: [],
            groupBy: null,
            visibleFields: null,
            columnOrder: null,
            isDefault: false,
            order: 0,
          },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

function findPostBody(fetchMock: ReturnType<typeof mockFetch>): unknown {
  const call = fetchMock.mock.calls.find(
    ([url, init]) =>
      String(url).endsWith('/api/v1/w/main/p/acme/views') && init?.method === 'POST',
  );
  expect(call).toBeDefined();
  return JSON.parse(call![1]!.body as string) as unknown;
}

describe('NewViewSheet', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders with "use current" checkbox checked by default', async () => {
    vi.stubGlobal('fetch', mockFetch());

    const { queryClient, router } = setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const checkbox = await screen.findByRole('checkbox', {
      name: /use current filters, sort, and columns/i,
    });
    expect(checkbox).toBeChecked();
  });

  it('submits an empty-shape payload when "use current" is unchecked', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = setup({ currentSearch: { status: 'Done' } });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await userEvent.type(await screen.findByLabelText(/Name/), 'X');
    await userEvent.click(
      screen.getByRole('checkbox', { name: /use current filters, sort, and columns/i }),
    );
    await userEvent.click(screen.getByRole('button', { name: /Create view/i }));

    await waitFor(() => expect(screen.getByText('navigated to work-items')).toBeInTheDocument());

    const body = findPostBody(fetchMock);
    expect(body).toEqual({ name: 'X', type: 'list', filters: {}, sort: [] });
  });

  it('includes URL filters and sort in the payload when "use current" is checked', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = setup({
      currentSearch: { status: 'In Progress', sort: 'title', dir: 'desc' },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await userEvent.type(await screen.findByLabelText(/Name/), 'My view');
    await userEvent.click(screen.getByRole('button', { name: /Create view/i }));

    await waitFor(() => expect(screen.getByText('navigated to work-items')).toBeInTheDocument());

    const body = findPostBody(fetchMock);
    expect(body).toEqual({
      name: 'My view',
      type: 'list',
      filters: { status: 'In Progress' },
      sort: [{ key: 'title', dir: 'desc' }],
    });
  });

  it('navigates to /work-items with ?view=<id> on mutation success', async () => {
    const fetchMock = mockFetch('v-new-7');
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await userEvent.type(await screen.findByLabelText(/Name/), 'X');
    await userEvent.click(screen.getByRole('button', { name: /Create view/i }));

    await waitFor(() => expect(screen.getByText('navigated to work-items')).toBeInTheDocument());

    expect(router.state.location.pathname).toBe('/w/main/p/acme/work-items');
    expect(router.state.location.search).toMatchObject({ view: 'v-new-7' });
  });
});
