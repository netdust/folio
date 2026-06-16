import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NewViewSheet } from './new-view-sheet.tsx';

interface SetupOpts {
  currentSearch?: Record<string, unknown>;
  currentColumns?: { visibleFields: string[] | null; columnOrder: string[] | null };
  // C3T9: the table the sheet creates the view on. Defaults to the default
  // table (work-items) so the pre-existing assertions keep their legacy routes.
  tslug?: string;
}

function setup({ currentSearch, currentColumns, tslug = 'work-items' }: SetupOpts = {}) {
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
        tslug={tslug}
        currentSearch={currentSearch ?? {}}
        currentColumns={currentColumns}
      />
    ),
  });
  // Phase 6 (Task 1.4/1.5): view-create ALWAYS lands on the unified /t/$tslug
  // route now — `resolveViewNav` is type-agnostic, so the legacy /work-items and
  // /board target routes below are only reachable via redirect, never directly
  // from a create. They stay registered so the router resolves cleanly, but no
  // create assertion lands on them anymore (the kanban-ness lives on the saved
  // view, resolved by ViewRouter, not the URL).
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
  // Phase 6: the unified table route — every view-create now lands here.
  const tableGrid = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/t/$tslug',
    component: () => <div>navigated to table grid</div>,
  });
  const tableBoard = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/t/$tslug/board',
    component: () => <div>navigated to table board</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([home, workItems, board, tableGrid, tableBoard]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return { queryClient, router };
}

// Mirrors the real server's POST /views response shape (see
// apps/server/src/routes/views.ts: `return jsonOk(c, { view: row }, 201)`).
// The shape locked by apps/server/src/routes/views.test.ts "POST returns
// data.view.id as a unique non-empty string" must match here, or this
// suite stops protecting the production code path.
function mockFetch(
  viewId = 'v-new',
  createdType: 'list' | 'kanban' = 'list',
  tslug = 'work-items',
) {
  return vi.fn<typeof fetch>(async (url, init) => {
    const u = String(url);
    // C3T9: views are created on the table-scoped collection (/t/<tslug>/views).
    if (u.endsWith(`/api/v1/w/main/p/acme/t/${tslug}/views`) && init?.method === 'POST') {
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
    // The sheet loads the active table's fields to offer kanban group-by options.
    if (u.includes(`/t/${tslug}/fields`)) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: 'f1',
              key: 'priority',
              type: 'select',
              label: 'Priority',
              options: ['Low', 'High'],
              required: false,
              order: 1,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

function findPostBody(fetchMock: ReturnType<typeof mockFetch>, tslug = 'work-items'): unknown {
  const call = fetchMock.mock.calls.find(
    ([url, init]) =>
      String(url).endsWith(`/api/v1/w/main/p/acme/t/${tslug}/views`) && init?.method === 'POST',
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

    await waitFor(() => expect(screen.getByText('navigated to table grid')).toBeInTheDocument());

    const body = findPostBody(fetchMock);
    // L.4: a list view now carries its default grouped-list config in `settings`
    // (group-by status, one `count` aggregate, title primary row).
    expect(body).toEqual({
      name: 'X',
      type: 'list',
      filters: {},
      sort: [],
      settings: {
        groupBy: 'status',
        aggregates: [{ op: 'count' }],
        rowLayout: { primary: 'title', fields: [] },
      },
    });
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

    await waitFor(() => expect(screen.getByText('navigated to table grid')).toBeInTheDocument());

    const body = findPostBody(fetchMock);
    expect(body).toEqual({
      name: 'My view',
      type: 'list',
      filters: { status: 'In Progress' },
      sort: [{ key: 'title', dir: 'desc' }],
      // L.4: list views carry the default grouped-list config in `settings`.
      settings: {
        groupBy: 'status',
        aggregates: [{ op: 'count' }],
        rowLayout: { primary: 'title', fields: [] },
      },
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
    await waitFor(() => expect(screen.getByText('navigated to table grid')).toBeInTheDocument());

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
    await waitFor(() => expect(screen.getByText('navigated to table grid')).toBeInTheDocument());
    const body = findPostBody(fetchMock) as Record<string, unknown>;
    expect(body).not.toHaveProperty('visibleFields');
    expect(body).not.toHaveProperty('columnOrder');
  });

  // Phase 6 (Task 1.4/1.5): a list view on the default table now lands on the
  // unified /t/$tslug route (no more /work-items for view-create) — the legacy
  // path is redirect-only.
  it('navigates to the unified /t/$tslug route with ?view=<id> on mutation success', async () => {
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

    await waitFor(() => expect(screen.getByText('navigated to table grid')).toBeInTheDocument());

    expect(router.state.location.pathname).toBe('/w/main/p/acme/t/work-items');
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
    await waitFor(() => expect(screen.getByText('navigated to table grid')).toBeInTheDocument());
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
    await userEvent.click(await screen.findByRole('button', { name: /Kanban/i }));
    // The group-by selector appears; pick the Priority field (default is Status → null).
    const groupBy = await screen.findByLabelText(/Group by/i);
    await userEvent.selectOptions(groupBy, 'priority');
    await userEvent.click(screen.getByRole('button', { name: /Create view/i }));
    await waitFor(() => expect(screen.getByText('navigated to table grid')).toBeInTheDocument());
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
    await userEvent.click(await screen.findByRole('button', { name: /Kanban/i }));
    await userEvent.click(screen.getByRole('button', { name: /Create view/i }));
    await waitFor(() => expect(screen.getByText('navigated to table grid')).toBeInTheDocument());
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
              {
                id: 'f1',
                key: 'priority',
                type: 'select',
                label: 'Priority',
                options: ['Low', 'High'],
                required: false,
                order: 1,
              },
              {
                id: 'f2',
                key: 'labels',
                type: 'multi_select',
                label: 'Labels',
                options: ['bug', 'feat'],
                required: false,
                order: 2,
              },
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
    await userEvent.click(await screen.findByRole('button', { name: /Kanban/i }));
    const groupBy = await screen.findByLabelText(/Group by/i);

    // The non-multi_select field IS offered as a group-by option…
    expect(within(groupBy).getByRole('option', { name: 'Priority' })).toBeInTheDocument();
    // …but the multi_select field is NOT.
    expect(within(groupBy).queryByRole('option', { name: 'Labels' })).toBeNull();
  });

  // Phase 6 (Task 1.4/1.5): a kanban view no longer routes to /board. ALL
  // view-creates land on the unified /t/$tslug route — the kanban-ness is now a
  // property of the saved view, resolved by <ViewRouter>, not encoded in the
  // URL. (This is the Option-B routing change; /board is redirect-only.)
  it('navigates to the unified /t/$tslug route after creating a kanban view', async () => {
    const fetchMock = mockFetch('v-kb3', 'kanban');
    vi.stubGlobal('fetch', fetchMock);
    const { queryClient, router } = setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await userEvent.type(await screen.findByLabelText(/Name/), 'KB');
    await userEvent.click(await screen.findByRole('button', { name: /Kanban/i }));
    await userEvent.click(screen.getByRole('button', { name: /Create view/i }));
    await waitFor(() => expect(screen.getByText('navigated to table grid')).toBeInTheDocument());
    expect(router.state.location.pathname).toBe('/w/main/p/acme/t/work-items');
    expect(router.state.location.search).toMatchObject({ view: 'v-kb3' });
  });

  // C3T9 (Tier A — create-target table). The sheet must create the view on the
  // CAPTURED table, not hardcode work-items: a view created on the wrong table
  // writes data to the wrong surface. With tslug="bugs" the POST must hit
  // /t/bugs/views (not /t/work-items/views) AND the success nav must land on
  // /t/bugs (the table's own grid), NOT /work-items.
  it('creates the view on the captured table and routes to /t/<tslug> (list)', async () => {
    const fetchMock = mockFetch('v-bug-1', 'list', 'bugs');
    vi.stubGlobal('fetch', fetchMock);
    const { queryClient, router } = setup({ tslug: 'bugs' });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await userEvent.type(await screen.findByLabelText(/Name/), 'Bug view');
    await userEvent.click(screen.getByRole('button', { name: /Create view/i }));
    await waitFor(() => expect(screen.getByText('navigated to table grid')).toBeInTheDocument());

    // Create-target: POST went to the bugs table's views collection.
    const bugsPost = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/api/v1/w/main/p/acme/t/bugs/views') && init?.method === 'POST',
    );
    expect(bugsPost).toBeDefined();
    // Adversarial: it must NOT have created on the default table.
    const workItemsPost = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/api/v1/w/main/p/acme/t/work-items/views') && init?.method === 'POST',
    );
    expect(workItemsPost).toBeUndefined();

    // Nav-target: landed on the bugs grid, not /work-items.
    expect(router.state.location.pathname).toBe('/w/main/p/acme/t/bugs');
    expect(router.state.location.search).toMatchObject({ view: 'v-bug-1' });
  });

  // Phase 6 (Tier A — create-target table, unified route). A kanban view on a
  // non-default table still creates on the CAPTURED table (the wrong-table
  // adversarial case stays meaningful), but now routes to the unified /t/<tslug>
  // grid — the kanban-ness is on the saved view (resolved by ViewRouter), not
  // the URL. (Option B; /t/<tslug>/board is redirect-only.)
  it('routes a kanban view on a captured table to the unified /t/<tslug>', async () => {
    const fetchMock = mockFetch('v-bug-2', 'kanban', 'bugs');
    vi.stubGlobal('fetch', fetchMock);
    const { queryClient, router } = setup({ tslug: 'bugs' });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await userEvent.type(await screen.findByLabelText(/Name/), 'Bug board');
    await userEvent.click(await screen.findByRole('button', { name: /Kanban/i }));
    await userEvent.click(screen.getByRole('button', { name: /Create view/i }));
    await waitFor(() => expect(screen.getByText('navigated to table grid')).toBeInTheDocument());

    // Adversarial: it must NOT have created on the default table.
    const workItemsPost = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/api/v1/w/main/p/acme/t/work-items/views') && init?.method === 'POST',
    );
    expect(workItemsPost).toBeUndefined();

    expect(router.state.location.pathname).toBe('/w/main/p/acme/t/bugs');
    expect(router.state.location.search).toMatchObject({ view: 'v-bug-2' });
  });

  // L.4 (Tier-A slice): a List view carries its assembled GroupedListSettings in
  // payload.settings. Configuring two aggregates writes BOTH into
  // settings.aggregates (the create-payload shape that the renderer reads back).
  // This drives the real buildPayload → POST body through the un-mocked sheet
  // state (GroupedListConfig threaded into the sheet), the seam that L.4 wires.
  it('writes the grouped-list settings (two aggregates) into a list payload.settings', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { queryClient, router } = setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await userEvent.type(await screen.findByLabelText(/Name/), 'Grouped');
    // type defaults to List → the GroupedListConfig block is shown.
    // Configure aggregate 1 → avg over `priority`.
    await userEvent.selectOptions(await screen.findByLabelText(/Aggregation 1/i), 'avg');
    await userEvent.selectOptions(screen.getByLabelText(/Aggregate field 1/i), 'priority');
    // Add aggregate 2 → count.
    await userEvent.click(screen.getByRole('button', { name: /Add aggregate/i }));
    await userEvent.selectOptions(await screen.findByLabelText(/Aggregation 2/i), 'count');

    await userEvent.click(screen.getByRole('button', { name: /Create view/i }));
    await waitFor(() => expect(screen.getByText('navigated to table grid')).toBeInTheDocument());

    const body = findPostBody(fetchMock) as Record<string, unknown>;
    expect(body.type).toBe('list');
    const settings = body.settings as { aggregates?: unknown[] } | undefined;
    expect(settings?.aggregates).toHaveLength(2);
    expect(settings?.aggregates?.[0]).toMatchObject({ op: 'avg', field: 'priority' });
    expect(settings?.aggregates?.[1]).toMatchObject({ op: 'count' });
  });

  // Adversarial sibling: a kanban view must NOT carry grouped-list settings (the
  // list-only block stays off for non-list types).
  it('omits payload.settings for a kanban view', async () => {
    const fetchMock = mockFetch('v-kb-s', 'kanban');
    vi.stubGlobal('fetch', fetchMock);
    const { queryClient, router } = setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await userEvent.type(await screen.findByLabelText(/Name/), 'KB');
    await userEvent.click(await screen.findByRole('button', { name: /Kanban/i }));
    await userEvent.click(screen.getByRole('button', { name: /Create view/i }));
    await waitFor(() => expect(screen.getByText('navigated to table grid')).toBeInTheDocument());
    const body = findPostBody(fetchMock) as Record<string, unknown>;
    expect(body).not.toHaveProperty('settings');
  });

  // Spec-coverage guard (Tier B): the 5-type enumeration is a spec contract.
  // `table` is intentionally absent (seed-created default, not user-picked). A
  // regression that drops calendar/timeline/gallery from the picker would
  // silently re-narrow the sheet to the old List/Kanban-only choice.
  it('offers all five view types', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    const { queryClient, router } = setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    // The sheet mounts async (Radix portal) — wait for it like the other tests.
    await screen.findByLabelText(/Name/);
    for (const t of ['List', 'Kanban', 'Calendar', 'Timeline', 'Gallery']) {
      expect(screen.getByLabelText(t)).toBeInTheDocument();
    }
    // `table` is NOT user-creatable here.
    expect(screen.queryByLabelText('Table')).toBeNull();
  });
});
