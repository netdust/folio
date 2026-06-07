import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
  currentColumns?: { visibleFields: string[] | null; columnOrder: string[] | null };
}

function setup({ currentSearch, currentColumns }: SetupOpts = {}) {
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
        currentSearch={currentSearch ?? {}}
        currentColumns={currentColumns}
      />
    ),
  });
  const workItems = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/work-items',
    component: () => <div>navigated to work-items</div>,
  });
  const board = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/board',
    component: () => <div>navigated to board</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([home, workItems, board]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return { queryClient, router };
}

// Mirrors the real server's POST /views response shape (see
// apps/server/src/routes/views.ts: `return jsonOk(c, { view: row }, 201)`).
// The shape locked by apps/server/src/routes/views.test.ts "POST returns
// data.view.id as a unique non-empty string" must match here, or this
// suite stops protecting the production code path.
function mockFetch(viewId = 'v-new', createdType: 'list' | 'kanban' = 'list') {
  return vi.fn<typeof fetch>(async (url, init) => {
    const u = String(url);
    if (u.endsWith('/api/v1/w/main/p/acme/views') && init?.method === 'POST') {
      return new Response(
        JSON.stringify({
          data: {
            view: {
              id: viewId,
              name: 'X',
              type: createdType,
              filters: {},
              sort: [],
              groupBy: null,
              visibleFields: null,
              columnOrder: null,
              isDefault: false,
              order: 0,
            },
          },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }
    // The sheet loads the project's fields to offer kanban group-by options.
    if (u.includes('/t/work-items/fields')) {
      return new Response(
        JSON.stringify({
          data: [
            { id: 'f1', key: 'priority', type: 'select', label: 'Priority', options: ['Low', 'High'], required: false, order: 1 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
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

  it('submits an empty-shape payload when no URL filters are set', async () => {
    const fetchMock = mockFetch();
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

    const body = findPostBody(fetchMock);
    expect(body).toEqual({ name: 'X', type: 'list', filters: {}, sort: [] });
  });

  it('always captures current URL filters and sort in the payload', async () => {
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

  it('captures the current columns (visibleFields + columnOrder) in the payload', async () => {
    // V2 (views UX shake-out): the sheet copy promises "Captures the current …
    // columns", but buildPayload omitted visibleFields/columnOrder → the server
    // stored []. Now the caller passes the active view's columns and they ride the
    // payload, so a new view starts as a copy of what the user is looking at.
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = setup({
      currentColumns: {
        visibleFields: ['title', 'status', 'assignee'],
        columnOrder: ['status', 'title', 'assignee'],
      },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await userEvent.type(await screen.findByLabelText(/Name/), 'Cols');
    await userEvent.click(screen.getByRole('button', { name: /Create view/i }));
    await waitFor(() => expect(screen.getByText('navigated to work-items')).toBeInTheDocument());

    const body = findPostBody(fetchMock) as Record<string, unknown>;
    expect(body.visibleFields).toEqual(['title', 'status', 'assignee']);
    expect(body.columnOrder).toEqual(['status', 'title', 'assignee']);
  });

  it('omits column keys when no current columns are provided (server defaults)', async () => {
    const fetchMock = mockFetch();
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
    const body = findPostBody(fetchMock) as Record<string, unknown>;
    expect(body).not.toHaveProperty('visibleFields');
    expect(body).not.toHaveProperty('columnOrder');
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

  // 4a: the sheet now offers a List/Kanban type selector. Default is List, and a
  // List payload must NOT carry a kanban groupBy.
  it('defaults to a List type and omits groupBy', async () => {
    const fetchMock = mockFetch();
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
    const body = findPostBody(fetchMock) as Record<string, unknown>;
    expect(body.type).toBe('list');
    expect(body).not.toHaveProperty('groupBy');
  });

  // 4a: selecting Kanban + a group-by field produces { type:'kanban', groupBy:<key> }.
  it('selecting Kanban + a group-by field produces a kanban payload with that groupBy', async () => {
    const fetchMock = mockFetch('v-kb', 'kanban');
    vi.stubGlobal('fetch', fetchMock);
    const { queryClient, router } = setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await userEvent.type(await screen.findByLabelText(/Name/), 'Board view');
    // Pick the Kanban type.
    await userEvent.click(await screen.findByRole('radio', { name: /Kanban/i }));
    // The group-by selector appears; pick the Priority field (default is Status → null).
    const groupBy = await screen.findByLabelText(/Group by/i);
    await userEvent.selectOptions(groupBy, 'priority');
    await userEvent.click(screen.getByRole('button', { name: /Create view/i }));
    await waitFor(() => expect(screen.getByText('navigated to board')).toBeInTheDocument());
    const body = findPostBody(fetchMock) as Record<string, unknown>;
    expect(body.type).toBe('kanban');
    expect(body.groupBy).toBe('priority');
  });

  // 4a: Kanban + the default group-by (Status) stores groupBy as null (the
  // "defaults to status" convention from board-controls).
  it('Kanban with the default Status group-by stores groupBy as null', async () => {
    const fetchMock = mockFetch('v-kb2', 'kanban');
    vi.stubGlobal('fetch', fetchMock);
    const { queryClient, router } = setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await userEvent.type(await screen.findByLabelText(/Name/), 'Status board');
    await userEvent.click(await screen.findByRole('radio', { name: /Kanban/i }));
    await userEvent.click(screen.getByRole('button', { name: /Create view/i }));
    await waitFor(() => expect(screen.getByText('navigated to board')).toBeInTheDocument());
    const body = findPostBody(fetchMock) as Record<string, unknown>;
    expect(body.type).toBe('kanban');
    expect(body.groupBy).toBeNull();
  });

  // Blind-spot close (hardening): new-view-sheet filters multi_select fields out
  // of the kanban group-by options (`fields.filter((f) => f.type !== 'multi_select')`),
  // mirroring what the board can actually group by. No test pinned that
  // exclusion — a regression that dropped the filter would offer an
  // ungroupable multi_select field, producing a board the server can't render.
  // Assert the multi_select field is absent from the <select> while a
  // non-multi_select field is present.
  it('excludes multi_select fields from the kanban group-by options', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      if (u.endsWith('/api/v1/w/main/p/acme/views') && init?.method === 'POST') {
        return new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/t/work-items/fields')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'f1', key: 'priority', type: 'select', label: 'Priority', options: ['Low', 'High'], required: false, order: 1 },
              { id: 'f2', key: 'labels', type: 'multi_select', label: 'Labels', options: ['bug', 'feat'], required: false, order: 2 },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await userEvent.type(await screen.findByLabelText(/Name/), 'Grouped board');
    await userEvent.click(await screen.findByRole('radio', { name: /Kanban/i }));
    const groupBy = await screen.findByLabelText(/Group by/i);

    // The non-multi_select field IS offered as a group-by option…
    expect(within(groupBy).getByRole('option', { name: 'Priority' })).toBeInTheDocument();
    // …but the multi_select field is NOT.
    expect(within(groupBy).queryByRole('option', { name: 'Labels' })).toBeNull();
  });

  // 4a: a kanban view navigates to /board, not /work-items.
  it('navigates to /board after creating a kanban view', async () => {
    const fetchMock = mockFetch('v-kb3', 'kanban');
    vi.stubGlobal('fetch', fetchMock);
    const { queryClient, router } = setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await userEvent.type(await screen.findByLabelText(/Name/), 'KB');
    await userEvent.click(await screen.findByRole('radio', { name: /Kanban/i }));
    await userEvent.click(screen.getByRole('button', { name: /Create view/i }));
    await waitFor(() => expect(screen.getByText('navigated to board')).toBeInTheDocument());
    expect(router.state.location.pathname).toBe('/w/main/p/acme/board');
    expect(router.state.location.search).toMatchObject({ view: 'v-kb3' });
  });
});
