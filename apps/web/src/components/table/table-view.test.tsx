import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { TableView, sameSearchValue } from './table-view.tsx';

// Import the same Zod schema the production work-items route uses so the
// test harness's strip/accept behavior tracks production exactly.
import { Route as WorkItemsRoute } from '../../routes/w.$wslug.p.$pslug.work-items.tsx';

function setup(initialEntry = '/w/acme/p/web/work-items') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const work = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/work-items',
    validateSearch: WorkItemsRoute.options.validateSearch,
    component: () => {
      const { wslug, pslug } = work.useParams();
      return <TableView wslug={wslug} pslug={pslug} tslug="work-items" />;
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([work]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  return { queryClient, router };
}

const docRow = {
  id: 'd1',
  slug: 'first',
  type: 'work_item' as const,
  title: 'First task',
  status: 'todo' as string | null,
  parentId: null,
  frontmatter: { amount: 1250 },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: new Date().toISOString(),
};

const statusRow = {
  id: 's1',
  key: 'todo',
  name: 'Todo',
  color: '#3b82f6',
  category: 'unstarted' as const,
  order: 0,
};

const fieldRow = {
  id: 'f1',
  key: 'amount',
  type: 'currency',
  label: 'Amount',
  options: ['EUR'],
  required: false,
  order: 0,
};

const viewRow = {
  id: 'v1',
  slug: 'default',
  name: 'All',
  type: 'list' as const,
  filters: {},
  sort: [],
  groupBy: null,
  visibleFields: ['title', 'status', 'updated_at', 'amount'],
  columnOrder: null,
  isDefault: true,
  order: 0,
};

describe('sameSearchValue', () => {
  it('treats equal scalars as equal', () => {
    expect(sameSearchValue('a', 'a')).toBe(true);
    expect(sameSearchValue(undefined, undefined)).toBe(true);
    expect(sameSearchValue('a', 'b')).toBe(false);
  });

  it('treats arrays with matching contents as equal even when references differ', () => {
    // The bug: `===` would say two distinct arrays are unequal and trigger a
    // redundant replace-navigate every render the URL is rebuilt from a
    // stored view's filter values.
    expect(sameSearchValue(['todo', 'done'], ['todo', 'done'])).toBe(true);
    expect(sameSearchValue(['todo'], ['todo', 'done'])).toBe(false);
    expect(sameSearchValue(['todo', 'done'], ['done', 'todo'])).toBe(false);
  });

  it('rejects array-vs-scalar mismatch', () => {
    expect(sameSearchValue(['todo'], 'todo')).toBe(false);
    expect(sameSearchValue('todo', ['todo'])).toBe(false);
  });
});

describe('TableView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('fetches fields from the table-scoped endpoint (/p/<pslug>/t/work-items/fields)', async () => {
    // Phase 1.9 Task 2: TableView must thread tslug into useFields so the
    // request goes to the table-scoped fields URL, not the project-scoped one.
    // The test passes any project slug; the assertion is on the URL substring
    // including "/t/work-items/fields".
    const fetchCalls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      fetchCalls.push(u);
      const method = init?.method ?? 'GET';
      if (u.includes('/statuses') && method === 'GET') {
        return new Response(JSON.stringify({ data: [statusRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [viewRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = setup('/w/acme/p/sales/work-items');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('First task')).toBeInTheDocument());

    expect(fetchCalls.some((u) => u.includes('/p/sales/t/work-items/fields'))).toBe(true);
  });

  it('renders columns from the active view including a currency cell', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/statuses') && method === 'GET') {
        return new Response(JSON.stringify({ data: [statusRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [viewRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
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

    // Doc row title
    await waitFor(() => expect(screen.getByText('First task')).toBeInTheDocument());

    // Column headers from the active view
    expect(screen.getByRole('button', { name: /Title/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Status/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Updated/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Amount/ })).toBeInTheDocument();

    // Status pill renders
    expect(screen.getByText('Todo')).toBeInTheDocument();

    // Currency cell shows the formatted value with €. Use a tolerant matcher because
    // Intl.NumberFormat output depends on the test env's default locale.
    const currencyCell = screen.getByText(
      (content) => /€/.test(content) && /1[\.,]250/.test(content),
    );
    expect(currencyCell).toBeInTheDocument();
  });

  it('the work-items route accepts any string as sort (so views can persist custom-field sorts)', () => {
    // Direct schema check — the production work-items route's validateSearch
    // must permit non-builtin sort keys so hydration from a saved view doesn't
    // get silently stripped. validateSearch can be either a Zod schema or a
    // plain function; handle both.
    const v = WorkItemsRoute.options.validateSearch as unknown;
    const parsed =
      typeof v === 'function'
        ? (v as (input: unknown) => Record<string, unknown>)({
            sort: 'next_action_due',
            dir: 'asc',
          })
        : (v as { parse: (input: unknown) => Record<string, unknown> }).parse({
            sort: 'next_action_due',
            dir: 'asc',
          });
    expect(parsed.sort).toBe('next_action_due');
    expect(parsed.dir).toBe('asc');
  });

  it('hydrates a view-saved sort key that is NOT in the URL validator enum', async () => {
    // Saved views can store sort by any column key (incl. custom field keys
    // like 'next_action_due'). The work-items route enum used to strip them
    // silently. Widening the validator to z.string() lets hydration apply
    // the view's sort intent unchanged.
    const customSortView = {
      ...viewRow,
      id: 'v-custom-sort',
      isDefault: false,
      filters: {},
      sort: [{ key: 'next_action_due', dir: 'asc' }],
    };
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/statuses') && method === 'GET') {
        return new Response(JSON.stringify({ data: [statusRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [customSortView] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = setup('/w/acme/p/web/work-items?view=v-custom-sort');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('First task')).toBeInTheDocument());

    await waitFor(() => {
      const s = router.state.location.search as Record<string, unknown>;
      expect(s.sort).toBe('next_action_due');
      expect(s.dir).toBe('asc');
    });
  });

  it('preserves user-supplied URL filter params over the view-stored value on first hydration', async () => {
    // Stored view filters status to "In Progress". User arrives with
    // ?view=v-triage&status=todo — that explicit URL filter must win.
    const triageView = {
      ...viewRow,
      id: 'v-triage',
      isDefault: false,
      filters: { status: { $eq: 'In Progress' } },
    };
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/statuses') && method === 'GET') {
        return new Response(JSON.stringify({ data: [statusRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [triageView] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = setup('/w/acme/p/web/work-items?view=v-triage&status=todo');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('First task')).toBeInTheDocument());

    await waitFor(() => {
      const s = router.state.location.search as Record<string, unknown>;
      expect(s.view).toBe('v-triage');
      // URL's explicit status=todo wins over view's stored "In Progress".
      expect(s.status).toBe('todo');
    });
  });

  it('hydrates URL filters from the active view when ?view= matches a non-default view', async () => {
    const defaultView = {
      ...viewRow,
      id: 'v-default',
      slug: 'all',
      name: 'All',
      isDefault: true,
      filters: {},
    };
    const triageView = {
      ...viewRow,
      id: 'v-triage',
      slug: 'triage',
      name: 'Triage',
      isDefault: false,
      filters: { status: { $eq: 'In Progress' } },
    };

    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/statuses') && method === 'GET') {
        return new Response(JSON.stringify({ data: [statusRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [defaultView, triageView] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = setup('/w/acme/p/web/work-items?view=v-triage');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('First task')).toBeInTheDocument());

    await waitFor(() => {
      const s = router.state.location.search as Record<string, unknown>;
      expect(s.view).toBe('v-triage');
      expect(s.status).toBe('In Progress');
    });
  });

  it('does NOT auto-save filter changes to the default view when no ?view= is in the URL', async () => {
    // Default view carries a saved status filter. Hydration will fill ?status=todo
    // into the URL on first paint. User removes the chip → onClauseChange fires
    // with no urlViewId. Expected: the default view is NOT mutated.
    const defaultView = {
      ...viewRow,
      id: 'v-default',
      slug: 'all',
      name: 'All',
      isDefault: true,
      filters: { status: 'todo' },
    };

    const updateViewCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];

    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/statuses') && method === 'GET') {
        return new Response(JSON.stringify({ data: [statusRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [defaultView] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.match(/\/views\/v-default/) && method === 'PATCH') {
        const body = await (init?.body instanceof ReadableStream
          ? new Response(init.body).text()
          : Promise.resolve(String(init?.body ?? '{}')));
        updateViewCalls.push({ id: 'v-default', patch: JSON.parse(body) });
        return new Response(JSON.stringify(defaultView), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    // No ?view= in URL: user has not explicitly opened the default view.
    const { queryClient, router } = setup('/w/acme/p/web/work-items');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('First task')).toBeInTheDocument());

    // Hydration populates the chip from the default view's saved filter.
    const removeBtn = await screen.findByRole('button', { name: /Remove status filter/i });
    await act(async () => {
      fireEvent.click(removeBtn);
    });

    // onClauseChange always navigates (dropping the status param) BEFORE the
    // guarded autosave decision. Awaiting the router reflecting that navigation
    // is the deterministic post-condition that the whole handler — including the
    // (suppressed) autosave branch — has run; then assert no PATCH fired.
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('status'));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Remove status filter/i })).toBeNull(),
    );

    // No ?view= → activeView is the default view by fallback. User removing
    // a chip is an ad-hoc filter change; it must NOT mutate the default view.
    expect(updateViewCalls).toEqual([]);
  });

  it('clicking a sort header does NOT patch view.sort when no ?view= is in the URL', async () => {
    const defaultView = {
      ...viewRow,
      id: 'v-default',
      isDefault: true,
      filters: {},
      sort: [],
    };
    const updateViewCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];

    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/statuses') && method === 'GET') {
        return new Response(JSON.stringify({ data: [statusRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [defaultView] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.match(/\/views\/v-default/) && method === 'PATCH') {
        const body = await (init?.body instanceof ReadableStream
          ? new Response(init.body).text()
          : Promise.resolve(String(init?.body ?? '{}')));
        updateViewCalls.push({ id: 'v-default', patch: JSON.parse(body) });
        return new Response(JSON.stringify(defaultView), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = setup('/w/acme/p/web/work-items');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('First task')).toBeInTheDocument());

    const titleHeader = screen.getByRole('button', { name: /Title/ });
    await act(async () => {
      fireEvent.click(titleHeader);
    });

    // onSortChange navigates (setting ?sort=title) BEFORE the guarded autosave.
    // Awaiting the router reflecting that sort param is the deterministic proof
    // the handler ran through the autosave branch; then assert no PATCH fired.
    await waitFor(() => expect(router.state.location.search).toMatchObject({ sort: 'title' }));

    expect(updateViewCalls).toEqual([]);
  });

  it('renders an add-row at the end of the list when there are existing docs', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/statuses') && method === 'GET') {
        return new Response(JSON.stringify({ data: [statusRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [viewRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
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

    await waitFor(() => expect(screen.getByText('First task')).toBeInTheDocument());
    expect(screen.getByTestId('table-add-row')).toBeInTheDocument();
  });

  it('typing in the add-row and committing creates a doc and opens the slideover', async () => {
    const createCalls: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/statuses') && method === 'GET') {
        return new Response(JSON.stringify({ data: [statusRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [viewRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.endsWith('/documents') && method === 'POST') {
        const body =
          init?.body instanceof ReadableStream
            ? await new Response(init.body).text()
            : String(init?.body ?? '{}');
        const parsed = JSON.parse(body);
        createCalls.push(parsed);
        return new Response(
          JSON.stringify({ ...docRow, slug: 'new-thing', title: parsed.title ?? 'Untitled' }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
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

    await waitFor(() => expect(screen.getByText('First task')).toBeInTheDocument());

    // Click the add-row's static "Add work item" affordance to start editing.
    const trigger = screen.getByRole('button', { name: /Add work item/ });
    await act(async () => {
      fireEvent.click(trigger);
    });

    // The InlineEdit input is now mounted with aria-label "New work item title".
    const input = await screen.findByRole('textbox', { name: /New work item title/ });
    await act(async () => {
      fireEvent.change(input, { target: { value: 'Shiny new item' } });
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    // POST must have fired with the typed title; slideover opens on the new slug.
    await waitFor(() => expect(createCalls.length).toBe(1));
    expect(createCalls[0].title).toBe('Shiny new item');
    expect(createCalls[0].type).toBe('work_item');

    await waitFor(() => {
      const s = router.state.location.search as Record<string, unknown>;
      expect(s.doc).toBe('new-thing');
    });
  });

  it('committing an empty title from the add-row does NOT create a doc', async () => {
    const createCalls: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/statuses') && method === 'GET') {
        return new Response(JSON.stringify({ data: [statusRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [viewRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.endsWith('/documents') && method === 'POST') {
        const body =
          init?.body instanceof ReadableStream
            ? await new Response(init.body).text()
            : String(init?.body ?? '{}');
        createCalls.push(JSON.parse(body));
        return new Response(JSON.stringify(docRow), { status: 201 });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
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

    await waitFor(() => expect(screen.getByText('First task')).toBeInTheDocument());

    const trigger = screen.getByRole('button', { name: /Add work item/ });
    await act(async () => {
      fireEvent.click(trigger);
    });
    const input = await screen.findByRole('textbox', { name: /New work item title/ });
    await act(async () => {
      fireEvent.blur(input);
    });

    // Blur with an empty title runs InlineEdit's commit → setEditing(false),
    // which removes the textbox; because the draft equals the empty value, the
    // onCreate callback is never reached. Awaiting the textbox's removal is the
    // deterministic post-condition that the blur handler fully ran; then assert
    // no document POST fired.
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: /New work item title/ })).toBeNull(),
    );
    expect(createCalls).toEqual([]);
  });

  it('renders the table scroll container as a flex-fill overflow-auto strip so the scrollbar sits at the viewport bottom', async () => {
    // The MainFrame layout requires TableView's outer wrapper to fill its
    // height (`h-full min-h-0 flex-col`) and the inner scroll strip to be
    // `flex-1 min-h-0 overflow-auto`. Without these classes the horizontal
    // scrollbar drifts below the viewport once the row count grows past the
    // visible area. This is a class-shape assertion — the visual outcome is
    // covered by the manual smoke test.
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/statuses') && method === 'GET') {
        return new Response(JSON.stringify({ data: [statusRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [viewRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
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

    await waitFor(() => expect(screen.getByText('First task')).toBeInTheDocument());

    const scroll = screen.getByTestId('table-scroll');
    expect(scroll.className).toContain('overflow-auto');
    expect(scroll.className).toContain('flex-1');
    expect(scroll.className).toContain('min-h-0');
  });

  // Bug E (2026-05-26): when visible columns total wider than the viewport,
  // the rows' bottom border stopped at viewport width instead of extending
  // across the grid. Root cause was the inner table-scroll wrapper sizing to
  // its layout width (which the rows' `w-full` then inherited). Wrapper must
  // size to its content so rows + header span the full grid width even on
  // horizontal scroll.
  it('table-scroll inner wrapper is content-width so row borders span full grid', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/statuses') && method === 'GET') {
        return new Response(JSON.stringify({ data: [statusRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [viewRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
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
    await waitFor(() => expect(screen.getByText('First task')).toBeInTheDocument());

    const scroll = screen.getByTestId('table-scroll');
    const innerWrapper = scroll.firstElementChild as HTMLElement;
    expect(innerWrapper).toBeTruthy();
    expect(innerWrapper.className).toContain('w-max');
  });

  it('clicking a sortable column header writes URL AND patches view.sort', async () => {
    const mockView = {
      ...viewRow,
      id: 'v1',
      slug: 'default',
      name: 'All',
      isDefault: true,
      filters: {},
      sort: [],
      columnOrder: null,
      visibleFields: ['title', 'status', 'updated_at'],
    };

    const navigateCalls: Array<{ search: Record<string, unknown> }> = [];
    const updateViewCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];

    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/statuses') && method === 'GET') {
        return new Response(JSON.stringify({ data: [statusRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [mockView] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views/v1') && method === 'PATCH') {
        const body = await (init?.body instanceof ReadableStream
          ? new Response(init.body).text()
          : Promise.resolve(String(init?.body ?? '{}')));
        updateViewCalls.push({ id: 'v1', patch: JSON.parse(body) });
        return new Response(JSON.stringify(mockView), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    // ?view=v1 — user has explicitly opened this view, so sort auto-save fires.
    const { queryClient, router } = setup('/w/acme/p/web/work-items?view=v1');
    const originalNavigate = router.navigate;
    router.navigate = vi.fn(async (opts: any) => {
      if (opts.search) {
        navigateCalls.push({ search: opts.search });
      }
      return originalNavigate.call(router, opts);
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('First task')).toBeInTheDocument());

    // Find and click the "Title" column header to trigger sort
    const titleHeader = screen.getByRole('button', { name: /Title/ });
    fireEvent.click(titleHeader);

    // Assert: navigate was called with sort in search
    await waitFor(() => {
      expect(navigateCalls.some((call) => call.search.sort === 'title')).toBe(true);
    });

    // Assert: updateView mutation was called with sort array
    await waitFor(() => {
      expect(
        updateViewCalls.some(
          (call) =>
            Array.isArray(call.patch.sort) &&
            call.patch.sort.length === 1 &&
            call.patch.sort[0].key === 'title' &&
            call.patch.sort[0].dir === 'asc',
        ),
      ).toBe(true);
    });
  });

  it('clicking ⋯ → Rename swaps the column header for an inline input and PATCHes /fields/:id on Enter', async () => {
    // Phase 1.9 Task 6: the per-column ⋯ menu opens a popover; clicking
    // Rename swaps the static header label for an InlineEdit input. Pressing
    // Enter commits and PATCHes the field's label to the new value.
    const patchCalls: { id: string; body: Record<string, unknown> }[] = [];

    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/statuses') && method === 'GET') {
        return new Response(JSON.stringify({ data: [statusRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.match(/\/fields\/f1$/) && method === 'PATCH') {
        const body =
          init?.body instanceof ReadableStream
            ? await new Response(init.body).text()
            : String(init?.body ?? '{}');
        patchCalls.push({ id: 'f1', body: JSON.parse(body) });
        return new Response(JSON.stringify({ data: { field: { ...fieldRow, label: 'Total' } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [viewRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
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

    await waitFor(() => expect(screen.getByText('First task')).toBeInTheDocument());

    // The pinned Amount column owns a ⋯ trigger (built-ins like Title don't).
    // Open the menu, click Rename, then commit a new label.
    const menuButtons = screen.getAllByRole('button', { name: /column actions/i });
    await act(async () => {
      fireEvent.click(menuButtons[0]);
    });
    const renameItem = await screen.findByRole('menuitem', { name: /^rename$/i });
    await act(async () => {
      fireEvent.click(renameItem);
    });

    const input = await screen.findByRole('textbox', { name: /rename column amount/i });
    await act(async () => {
      fireEvent.change(input, { target: { value: 'Total' } });
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    await waitFor(() => expect(patchCalls.length).toBe(1));
    expect(patchCalls[0].id).toBe('f1');
    expect(patchCalls[0].body).toMatchObject({ label: 'Total' });
  });

  it('clicking ⋯ → Hide column patches the active view to drop the key from visibleFields', async () => {
    // Phase 1.9 Task 6: Hide removes the field's key from active view's
    // visibleFields and PATCHes the view. The pinned Amount column starts
    // visible; after Hide we expect the PATCH body to omit "amount".
    const viewPatchCalls: { id: string; body: Record<string, unknown> }[] = [];

    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/statuses') && method === 'GET') {
        return new Response(JSON.stringify({ data: [statusRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [viewRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.match(/\/views\/v1$/) && method === 'PATCH') {
        const body =
          init?.body instanceof ReadableStream
            ? await new Response(init.body).text()
            : String(init?.body ?? '{}');
        viewPatchCalls.push({ id: 'v1', body: JSON.parse(body) });
        return new Response(JSON.stringify(viewRow), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
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

    await waitFor(() => expect(screen.getByText('First task')).toBeInTheDocument());

    const menuButtons = screen.getAllByRole('button', { name: /column actions/i });
    await act(async () => {
      fireEvent.click(menuButtons[0]);
    });
    const hideItem = await screen.findByRole('menuitem', { name: /hide column/i });
    await act(async () => {
      fireEvent.click(hideItem);
    });

    await waitFor(() => expect(viewPatchCalls.length).toBeGreaterThan(0));
    const last = viewPatchCalls[viewPatchCalls.length - 1];
    expect(Array.isArray(last.body.visibleFields)).toBe(true);
    expect((last.body.visibleFields as string[]).includes('amount')).toBe(false);
  });

  it('clicking ⋯ → Delete column opens confirm dialog and DELETEs /fields/:id only after confirm', async () => {
    // Phase 1.9 Task 6: Delete opens a confirm dialog (so accidental clicks
    // can't drop a column). The DELETE request only fires after the user
    // clicks the destructive "Delete" button in the dialog.
    const deleteCalls: string[] = [];

    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/statuses') && method === 'GET') {
        return new Response(JSON.stringify({ data: [statusRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.match(/\/fields\/f1$/) && method === 'DELETE') {
        deleteCalls.push(u);
        return new Response(null, { status: 204 });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [viewRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
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

    await waitFor(() => expect(screen.getByText('First task')).toBeInTheDocument());

    const menuButtons = screen.getAllByRole('button', { name: /column actions/i });
    await act(async () => {
      fireEvent.click(menuButtons[0]);
    });
    const deleteItem = await screen.findByRole('menuitem', { name: /delete column/i });
    await act(async () => {
      fireEvent.click(deleteItem);
    });

    // Confirm dialog opens — no DELETE has fired yet.
    expect(await screen.findByText(/delete column .amount./i)).toBeInTheDocument();
    expect(deleteCalls).toEqual([]);

    const confirm = screen.getByRole('button', { name: /^delete$/i });
    await act(async () => {
      fireEvent.click(confirm);
    });

    await waitFor(() => expect(deleteCalls.length).toBe(1));
    expect(deleteCalls[0]).toContain('/fields/f1');
  });

  it('clicking + Add column posts to /fields and re-fetches', async () => {
    // Phase 1.9 Task 5: TableAddColumn must mount in the header, submit to
    // the table-scoped /fields endpoint, and trigger a refetch so the new
    // column appears immediately.
    const created: { url: string; body: unknown }[] = [];
    let createPosted = false;

    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';

      if (u.includes('/statuses') && method === 'GET') {
        return new Response(JSON.stringify({ data: [statusRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [viewRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.match(/\/views\/v1/) && method === 'PATCH') {
        return new Response(JSON.stringify(viewRow), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'POST') {
        const body =
          init?.body instanceof ReadableStream
            ? await new Response(init.body).text()
            : String(init?.body ?? '{}');
        const parsed = JSON.parse(body);
        created.push({ url: u, body: parsed });
        createPosted = true;
        return new Response(
          JSON.stringify({
            data: {
              field: {
                id: 'fnew',
                key: 'owner',
                type: 'string',
                label: 'Owner',
                options: null,
                required: false,
                order: 0,
              },
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(
          JSON.stringify({
            data: createPosted
              ? [
                  fieldRow,
                  {
                    id: 'fnew',
                    key: 'owner',
                    type: 'string',
                    label: 'Owner',
                    options: null,
                    required: false,
                    order: 0,
                  },
                ]
              : [fieldRow],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = setup('/w/acme/p/sales/work-items');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('First task')).toBeInTheDocument());

    const addBtn = await screen.findByRole('button', { name: /add column/i });
    await act(async () => {
      fireEvent.click(addBtn);
    });

    const keyInput = await screen.findByLabelText(/^key$/i);
    await act(async () => {
      fireEvent.change(keyInput, { target: { value: 'owner' } });
    });
    const createBtn = screen.getByRole('button', { name: /^create$/i });
    await act(async () => {
      fireEvent.click(createBtn);
    });

    await waitFor(() => {
      expect(created.length).toBe(1);
    });
    expect(created[0].url).toContain('/p/sales/t/work-items/fields');
    expect(created[0].body).toMatchObject({ key: 'owner', type: 'string' });
  });

  it('column picker lists orphan frontmatter keys under Suggested', async () => {
    // Phase 1.9 Task 8: ColumnPicker should surface unpinned frontmatter keys
    // (owner, extra_note) as suggestions when no Field row exists for them yet.
    const docWithExtras = {
      id: 'd2',
      slug: 'second',
      type: 'work_item' as const,
      title: 'Second task',
      status: 'todo' as string | null,
      parentId: null,
      frontmatter: { owner: 'Alice', extra_note: 'x' },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: new Date().toISOString(),
    };

    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/statuses') && method === 'GET') {
        return new Response(JSON.stringify({ data: [statusRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [viewRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docWithExtras], nextCursor: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = setup('/w/acme/p/sales/work-items');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('Second task')).toBeInTheDocument());

    const columnsBtn = await screen.findByRole('button', { name: /columns/i });
    await act(async () => {
      fireEvent.click(columnsBtn);
    });

    expect(await screen.findByText(/suggested from your data/i)).toBeInTheDocument();
    expect(screen.getByText('owner')).toBeInTheDocument();
    expect(screen.getByText('extra_note')).toBeInTheDocument();
  });

  it('clicking + Pin on a suggestion posts a field with the inferred type', async () => {
    // Phase 1.9 Task 8: clicking the +Pin IconButton on a suggested key should
    // POST a Field with the inferred type derived from the sample value.
    let pinned = false;
    const created: { url: string; body: unknown }[] = [];

    const docWithExtras = {
      id: 'd3',
      slug: 'third',
      type: 'work_item' as const,
      title: 'Third task',
      status: 'todo' as string | null,
      parentId: null,
      frontmatter: { owner: 'Alice' },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: new Date().toISOString(),
    };

    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/statuses') && method === 'GET') {
        return new Response(JSON.stringify({ data: [statusRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [viewRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'POST') {
        const body =
          init?.body instanceof ReadableStream
            ? await new Response(init.body).text()
            : String(init?.body ?? '{}');
        const parsed = JSON.parse(body);
        created.push({ url: u, body: parsed });
        pinned = true;
        return new Response(
          JSON.stringify({
            data: {
              field: {
                id: 'fnew',
                key: parsed.key,
                type: parsed.type,
                label: parsed.label,
                options: null,
                required: false,
                order: 0,
              },
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(
          JSON.stringify({
            data: pinned
              ? [
                  {
                    id: 'fnew',
                    key: 'owner',
                    type: 'string',
                    label: 'Owner',
                    options: null,
                    required: false,
                    order: 0,
                  },
                ]
              : [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docWithExtras], nextCursor: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = setup('/w/acme/p/sales/work-items');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('Third task')).toBeInTheDocument());

    const columnsBtn = await screen.findByRole('button', { name: /columns/i });
    await act(async () => {
      fireEvent.click(columnsBtn);
    });

    const pinBtn = await screen.findByRole('button', { name: /pin owner/i });
    await act(async () => {
      fireEvent.click(pinBtn);
    });

    await waitFor(() => {
      expect(created.length).toBe(1);
    });
    expect(created[0].body).toMatchObject({ key: 'owner', type: 'string' });
  });

  it('⋯ → Change type → Apply PATCHes /fields/:id with the new type and options', async () => {
    // Phase 1.9.1 Task 4: the per-column ⋯ menu now has a "Change type"
    // entry that opens ColumnTypeChange. Submitting the dialog PATCHes the
    // field's type (and for currency→non-currency, drops options to null).
    //
    // The field under test is currency 'amount'. We change it to 'number',
    // which per the dialog's compatibility matrix is a valid transition and
    // should send `options: null` to drop the ISO code.
    const numberField = {
      id: 'f1',
      key: 'amount',
      type: 'number' as const,
      label: 'Amount',
      options: null,
      required: false,
      order: 0,
    };
    const currencyField = {
      id: 'f1',
      key: 'amount',
      type: 'currency' as const,
      label: 'Amount',
      options: ['EUR'],
      required: false,
      order: 0,
    };
    // Start in 'number' so the dialog's compatibility matrix offers
    // 'currency' as a target. The flow we exercise is number → currency,
    // which is load-bearing because it has to send the [iso] options array.
    const patchCalls: { id: string; body: Record<string, unknown> }[] = [];

    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/statuses') && method === 'GET') {
        return new Response(JSON.stringify({ data: [statusRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [numberField] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.match(/\/fields\/f1$/) && method === 'PATCH') {
        const body =
          init?.body instanceof ReadableStream
            ? await new Response(init.body).text()
            : String(init?.body ?? '{}');
        patchCalls.push({ id: 'f1', body: JSON.parse(body) });
        return new Response(JSON.stringify({ data: { field: currencyField } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [viewRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
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

    await waitFor(() => expect(screen.getByText('First task')).toBeInTheDocument());

    // Open the ⋯ menu on the pinned Amount column, click Change type.
    const menuButtons = screen.getAllByRole('button', { name: /column actions/i });
    await act(async () => {
      fireEvent.click(menuButtons[0]);
    });
    const changeTypeItem = await screen.findByRole('menuitem', { name: /change type/i });
    await act(async () => {
      fireEvent.click(changeTypeItem);
    });

    // Dialog renders the type select. Pick 'currency'.
    const typeSelect = await screen.findByLabelText(/new type/i);
    await act(async () => {
      fireEvent.change(typeSelect, { target: { value: 'currency' } });
    });

    // ISO input appears for number → currency. Default 'EUR' is fine.
    const isoInput = await screen.findByLabelText(/iso code/i);
    expect((isoInput as HTMLInputElement).value).toBe('EUR');

    const applyBtn = screen.getByRole('button', { name: /^apply$/i });
    await act(async () => {
      fireEvent.click(applyBtn);
    });

    await waitFor(() => expect(patchCalls.length).toBe(1));
    expect(patchCalls[0].id).toBe('f1');
    expect(patchCalls[0].body).toMatchObject({ type: 'currency', options: ['EUR'] });
  });

  it('⋯ → Change type currency→number sends options: null and PATCHes /fields/:id', async () => {
    // Phase 1.9.1 Task 4 follow-up: regression guard for the currency→non-currency
    // path. The client must send `options: null` so the server's PATCH handler
    // drops the ISO code. Before the Zod fix on the server, this round-trip was
    // rejected with HTTP 400 ("Expected array, received null").
    const currencyField = {
      id: 'f1',
      key: 'amount',
      type: 'currency' as const,
      label: 'Amount',
      options: ['EUR'],
      required: false,
      order: 0,
    };
    const numberField = {
      id: 'f1',
      key: 'amount',
      type: 'number' as const,
      label: 'Amount',
      options: null,
      required: false,
      order: 0,
    };
    const patchCalls: { id: string; body: Record<string, unknown> }[] = [];

    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/statuses') && method === 'GET') {
        return new Response(JSON.stringify({ data: [statusRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [currencyField] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.match(/\/fields\/f1$/) && method === 'PATCH') {
        const body =
          init?.body instanceof ReadableStream
            ? await new Response(init.body).text()
            : String(init?.body ?? '{}');
        patchCalls.push({ id: 'f1', body: JSON.parse(body) });
        return new Response(JSON.stringify({ data: { field: numberField } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [viewRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
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

    await waitFor(() => expect(screen.getByText('First task')).toBeInTheDocument());

    // Open the ⋯ menu on the pinned Amount column, click Change type.
    const menuButtons = screen.getAllByRole('button', { name: /column actions/i });
    await act(async () => {
      fireEvent.click(menuButtons[0]);
    });
    const changeTypeItem = await screen.findByRole('menuitem', { name: /change type/i });
    await act(async () => {
      fireEvent.click(changeTypeItem);
    });

    // Dialog renders the type select. Pick 'number'.
    const typeSelect = await screen.findByLabelText(/new type/i);
    await act(async () => {
      fireEvent.change(typeSelect, { target: { value: 'number' } });
    });

    const applyBtn = screen.getByRole('button', { name: /^apply$/i });
    await act(async () => {
      fireEvent.click(applyBtn);
    });

    await waitFor(() => expect(patchCalls.length).toBe(1));
    expect(patchCalls[0].id).toBe('f1');
    expect(patchCalls[0].body).toMatchObject({ type: 'number', options: null });
  });

  // Phase 3.x: the column-settings picker is pinned as a sticky right-most
  // table column, mirroring the sticky-left Title column. These two tests
  // assert the picker has MOVED out of the top filter bar and into a dedicated
  // pinned settings column in the header.
  function setupPinnedSettings(initialEntry = '/w/acme/p/web/work-items') {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/statuses') && method === 'GET') {
        return new Response(JSON.stringify({ data: [statusRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [viewRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = setup(initialEntry);
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    return { queryClient, router };
  }

  it('renders a pinned settings column header that opens the column picker', async () => {
    setupPinnedSettings();
    await waitFor(() => expect(screen.getByText('First task')).toBeInTheDocument());

    const settingsBtn = await screen.findByRole('button', { name: /columns/i });
    expect(settingsBtn).toBeInTheDocument();
    expect(settingsBtn.closest('[data-testid="table-settings-col"]')).toBeTruthy();
  });

  it('the top filter bar no longer contains the column picker', async () => {
    setupPinnedSettings();
    await waitFor(() => expect(screen.getByText('First task')).toBeInTheDocument());

    const filterBar = screen.getByTestId('filter-bar');
    expect(within(filterBar).queryByRole('button', { name: /columns/i })).toBeNull();
  });

  it('clicking a custom field header sorts by that field', async () => {
    // FS-2: every column header is sortable, not just built-ins. The seeded
    // default view exposes the custom currency field `amount` (label "Amount")
    // via visibleFields, so its header should be a sortable button.
    const mockView = {
      ...viewRow,
      id: 'v1',
      slug: 'default',
      name: 'All',
      isDefault: true,
      filters: {},
      sort: [],
      columnOrder: null,
      visibleFields: ['title', 'status', 'updated_at', 'amount'],
    };

    const navigateCalls: Array<{ search: Record<string, unknown> }> = [];
    const updateViewCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];

    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/statuses') && method === 'GET') {
        return new Response(JSON.stringify({ data: [statusRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [mockView] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views/v1') && method === 'PATCH') {
        const body = await (init?.body instanceof ReadableStream
          ? new Response(init.body).text()
          : Promise.resolve(String(init?.body ?? '{}')));
        updateViewCalls.push({ id: 'v1', patch: JSON.parse(body) });
        return new Response(JSON.stringify(mockView), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    // ?view=v1 — user has explicitly opened this view, so sort auto-save fires.
    const { queryClient, router } = setup('/w/acme/p/web/work-items?view=v1');
    const originalNavigate = router.navigate;
    router.navigate = vi.fn(async (opts: any) => {
      if (opts.search) {
        navigateCalls.push({ search: opts.search });
      }
      return originalNavigate.call(router, opts);
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('First task')).toBeInTheDocument());

    const fieldHeader = screen.getByRole('button', { name: /Amount/ });
    fireEvent.click(fieldHeader);

    await waitFor(() => {
      expect(navigateCalls.some((call) => call.search.sort === 'amount')).toBe(true);
    });

    await waitFor(() => {
      expect(
        updateViewCalls.some(
          (call) =>
            Array.isArray(call.patch.sort) &&
            call.patch.sort.length === 1 &&
            call.patch.sort[0].key === 'amount' &&
            call.patch.sort[0].dir === 'asc',
        ),
      ).toBe(true);
    });
  });
});

// C1T3 seam test: TableView must thread its `tslug` prop into the table-scoped
// data hooks (useDocuments / useStatuses) so list + status reads hit
// /w/<w>/p/<p>/t/<tslug>/... — NOT the old project-scoped /p/<p>/... path. This
// is the invariant-16 board-persistence seam: the active table must drive the
// reads (and, in KanbanView, the drag-PATCH). We assert through the un-mocked
// fetch wire (the same fetch-capture harness the rest of this file uses) that a
// non-default tslug reaches the documents AND statuses endpoints, plus a
// negative case that a DIFFERENT tslug does NOT hit the first tslug's path.
function setupTslug(tslug: string, initialEntry = '/w/acme/p/sales/work-items') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const work = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/work-items',
    validateSearch: WorkItemsRoute.options.validateSearch,
    component: () => {
      const { wslug, pslug } = work.useParams();
      return <TableView wslug={wslug} pslug={pslug} tslug={tslug} />;
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([work]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  return { queryClient, router };
}

function tableScopedFetch(calls: string[]) {
  return vi.fn<typeof fetch>(async (url, init) => {
    const u = String(url);
    calls.push(u);
    const method = init?.method ?? 'GET';
    if (u.includes('/statuses') && method === 'GET') {
      return new Response(JSON.stringify({ data: [statusRow] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/fields') && method === 'GET') {
      return new Response(JSON.stringify({ data: [fieldRow] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/views') && method === 'GET') {
      return new Response(JSON.stringify({ data: [viewRow] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/documents') && method === 'GET') {
      return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

describe('TableView table-scoped reads (C1T3 invariant-16 seam)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('threads tslug into useDocuments + useStatuses so reads hit /t/bugs/...', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', tableScopedFetch(calls));

    const { queryClient, router } = setupTslug('bugs');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('First task')).toBeInTheDocument());

    // Un-mocked-wire assertions: the active table 'bugs' drives both reads.
    expect(calls.some((u) => u.includes('/t/bugs/documents'))).toBe(true);
    expect(calls.some((u) => u.includes('/t/bugs/statuses'))).toBe(true);
    // And it must NOT fall back to the project-scoped path.
    expect(calls.some((u) => /\/p\/sales\/documents/.test(u))).toBe(false);
    expect(calls.some((u) => /\/p\/sales\/statuses/.test(u))).toBe(false);
  });

  it('negative: a different tslug (work-items) never hits the bugs endpoints', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', tableScopedFetch(calls));

    const { queryClient, router } = setupTslug('work-items');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('First task')).toBeInTheDocument());

    expect(calls.some((u) => u.includes('/t/work-items/documents'))).toBe(true);
    expect(calls.some((u) => u.includes('/t/bugs/'))).toBe(false);
  });

  // C3T10 — error-envelope contract on the table-scoped fetch path. A deep-link
  // to a nonexistent/forbidden table 404s/403s the documents read; TableView must
  // surface the error panel via the `error ?` branch, NOT a blank grid or crash.
  // RED if the error branch is ever removed for the table-scoped path.
  it('renders the error panel (not a crash) when the table-scoped documents fetch 404s', async () => {
    // Like tableScopedFetch, but the documents GET fails (deleted/forbidden table).
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const u = typeof input === 'string' ? input : input.toString();
        if (u.includes('/statuses') && !u.includes('/documents')) {
          return new Response(JSON.stringify({ data: [statusRow] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (u.includes('/fields')) {
          return new Response(JSON.stringify({ data: [fieldRow] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (u.includes('/views')) {
          return new Response(JSON.stringify({ data: [viewRow] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (u.includes('/documents')) {
          return new Response(
            JSON.stringify({
              error: { code: 'TABLE_NOT_FOUND', message: 'table "bugs" not found' },
            }),
            { status: 404, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );

    const { queryClient, router } = setupTslug('bugs');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    // The error panel renders; no white-screen, no thrown render.
    await waitFor(() => expect(screen.getByText(/Failed to load documents/i)).toBeInTheDocument());
  });
});

// ───────────────────────────────────────────────────────────────────────────
// M3: pagination (consume nextCursor) + server-side frontmatter filter.
// Tier A — these assert correctness contracts the user sees: a match on page 2
// IS shown (the bug being fixed), the priority filter goes to the server (not a
// client post-filter of page 1), pagination stops at the last page, and a
// double load-more does not double-fetch.
// ───────────────────────────────────────────────────────────────────────────
describe('TableView — pagination + server-side filter (M3)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const docOnPage = (id: string, title: string, frontmatter: Record<string, unknown> = {}) => ({
    id,
    slug: id,
    type: 'work_item' as const,
    title,
    status: 'todo' as string | null,
    parentId: null,
    frontmatter,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  });

  // Base fetch mock that always answers statuses/fields/views, and routes
  // /documents GET to the supplied handler (which receives the parsed URL).
  function makeFetch(documentsHandler: (u: URL) => unknown, documentUrls: string[]) {
    return vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (u.includes('/statuses') && method === 'GET') return json({ data: [statusRow] });
      if (u.includes('/fields') && method === 'GET') return json({ data: [] });
      if (u.includes('/views') && method === 'GET') return json({ data: [viewRow] });
      if (u.includes('/tables') && method === 'GET') return json({ data: [] });
      // viewRow is type:'list' → TableView issues a group-summary query. These
      // M3 pagination tests exercise the FLAT row path, so return an empty
      // summary (grouping falls back to flat) and keep it OUT of documentUrls —
      // its URL also contains "/documents", so it MUST be matched first.
      if (u.includes('/group-summary') && method === 'GET') {
        return json({ data: { groups: [], ungrouped: null, truncated: false } });
      }
      if (u.includes('/documents') && method === 'GET') {
        documentUrls.push(u);
        return json({ data: documentsHandler(new URL(u, 'http://test.local')) });
      }
      return json({});
    });
  }

  it('shows a match that only appears on page 2 (the regression being fixed)', async () => {
    const documentUrls: string[] = [];
    const fetchMock = makeFetch((u) => {
      const cursor = u.searchParams.get('cursor');
      if (!cursor) {
        return { data: [docOnPage('p1', 'Page one task')], nextCursor: 'cursor-2' };
      }
      return { data: [docOnPage('p2', 'Page two MATCH')], nextCursor: null };
    }, documentUrls);
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = setup('/w/acme/p/web/work-items');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('Page one task')).toBeInTheDocument());
    // Page-2 row is NOT present yet — it lives behind the cursor.
    expect(screen.queryByText('Page two MATCH')).toBeNull();

    const loadMore = await screen.findByTestId('load-more');
    fireEvent.click(loadMore);

    // After loading page 2, BOTH pages' rows are visible. Pre-M3 the table
    // truncated at page 1, so this row would never render.
    await waitFor(() => expect(screen.getByText('Page two MATCH')).toBeInTheDocument());
    expect(screen.getByText('Page one task')).toBeInTheDocument();
  });

  it('sends priority as a server-side ?filter= param (un-mocked builder seam)', async () => {
    const documentUrls: string[] = [];
    const fetchMock = makeFetch(
      () => ({ data: [docOnPage('p1', 'High task', { priority: 'high' })], nextCursor: null }),
      documentUrls,
    );
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = setup('/w/acme/p/web/work-items?priority=high');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('High task')).toBeInTheDocument());

    // The REAL clausesToListParams → toSearch builder produced this URL; no mock
    // intercepts the filter JSON. This proves priority crosses the wire to the
    // server, not a client post-filter of the current page.
    await waitFor(() => {
      const filtered = documentUrls.find((u) => u.includes('filter='));
      expect(filtered).toBeDefined();
      const parsed = JSON.parse(
        new URL(filtered as string, 'http://test.local').searchParams.get('filter') as string,
      );
      expect(parsed).toEqual({ priority: { $eq: 'high' } });
    });
  });

  it('does NOT request a next page when nextCursor is null (last page)', async () => {
    const documentUrls: string[] = [];
    const fetchMock = makeFetch(
      () => ({ data: [docOnPage('only', 'Only task')], nextCursor: null }),
      documentUrls,
    );
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = setup('/w/acme/p/web/work-items');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('Only task')).toBeInTheDocument());

    // No Load more button when the first page already exhausted the cursor.
    expect(screen.queryByTestId('load-more')).toBeNull();
    // Exactly one documents fetch (the relPages/relItems extra queries are
    // disabled — no relation column — so the only /documents GET is page 1).
    expect(documentUrls.length).toBe(1);
  });

  it('empty result → empty state, no Load more', async () => {
    const documentUrls: string[] = [];
    const fetchMock = makeFetch(() => ({ data: [], nextCursor: null }), documentUrls);
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = setup('/w/acme/p/web/work-items');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText(/No work items yet/i)).toBeInTheDocument());
    expect(screen.queryByTestId('load-more')).toBeNull();
  });

  it('double-clicking Load more does not double-fetch the same next page', async () => {
    const documentUrls: string[] = [];
    let page2Calls = 0;
    const fetchMock = makeFetch((u) => {
      const cursor = u.searchParams.get('cursor');
      if (!cursor) return { data: [docOnPage('p1', 'Page one')], nextCursor: 'cursor-2' };
      page2Calls += 1;
      return { data: [docOnPage('p2', 'Page two')], nextCursor: null };
    }, documentUrls);
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = setup('/w/acme/p/web/work-items');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const loadMore = await screen.findByTestId('load-more');
    // Two synchronous clicks: the button disables on isFetchingNextPage and
    // react-query dedupes the in-flight key, so page 2 is fetched once.
    fireEvent.click(loadMore);
    fireEvent.click(loadMore);

    await waitFor(() => expect(screen.getByText('Page two')).toBeInTheDocument());
    expect(page2Calls).toBe(1);
  });
});

// A.2: a `type:'list'` active view turns TableView into the GROUPED table — it
// renders a GroupHeaderRow section per endpoint group (count from the
// group-summary endpoint, NEVER from loaded-row counts), the group's TableRows
// under it, the ungrouped bucket last, and collapse hides a group's rows. A
// `type:'table'` view stays FLAT. Reuses ALL of TableView's existing wiring.
describe('TableView grouped (list view)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const listView = {
    ...viewRow,
    type: 'list' as const,
    settings: { groupBy: 'status', aggregates: [{ op: 'count' }] },
    visibleFields: ['title', 'status', 'updated_at'],
  };

  const tableView = {
    ...viewRow,
    type: 'table' as const,
    settings: {},
    visibleFields: ['title', 'status', 'updated_at'],
  };

  const doneStatus = { ...statusRow, id: 's-done', key: 'done', name: 'Done', order: 1 };
  const todoStatus = { ...statusRow, id: 's-todo', key: 'todo', name: 'Todo', order: 0 };

  const mkDoc = (id: string, title: string, status: string | null) => ({
    id,
    slug: id,
    type: 'work_item' as const,
    title,
    status: status as string | null,
    parentId: null,
    frontmatter: {},
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  });

  // The group-summary endpoint is the SOURCE OF TRUTH for counts: 'done' = 148,
  // 'todo' = 43, plus an ungrouped bucket of 5 — far more than the handful of
  // rows actually loaded below (the page-2 guard).
  const SUMMARY = {
    groups: [
      { value: 'done', count: 148, aggregates: { count: 148 } },
      { value: 'todo', count: 43, aggregates: { count: 43 } },
    ],
    ungrouped: { value: null, count: 5, aggregates: { count: 5 } },
    truncated: false,
  };

  // Only a couple of rows per group are LOADED (the endpoint reports far more).
  const LOADED = [
    mkDoc('d-done-1', 'Done one', 'done'),
    mkDoc('d-done-2', 'Done two', 'done'),
    mkDoc('d-todo-1', 'Todo one', 'todo'),
    mkDoc('d-none-1', 'No status item', null),
  ];

  function makeGroupedFetch(view: typeof listView | typeof tableView, summary = SUMMARY) {
    return vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (u.includes('/statuses') && method === 'GET')
        return json({ data: [todoStatus, doneStatus] });
      if (u.includes('/fields') && method === 'GET') return json({ data: [] });
      if (u.includes('/views') && method === 'GET') return json({ data: [view] });
      if (u.includes('/tables') && method === 'GET') return json({ data: [] });
      // group-summary BEFORE the generic /documents branch (its URL also
      // contains "/documents").
      if (u.includes('/group-summary') && method === 'GET') return json({ data: summary });
      if (u.includes('/documents') && method === 'GET')
        return json({ data: { data: LOADED, nextCursor: null } });
      return json({});
    });
  }

  it('renders a GroupHeaderRow per endpoint group with the FULL-SET count, not the loaded count', async () => {
    vi.stubGlobal('fetch', makeGroupedFetch(listView));
    const { queryClient, router } = setup('/w/acme/p/web/work-items');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    // One header per group, keyed by the endpoint value.
    const doneHeader = await screen.findByTestId('group-header-row-status-done');
    const todoHeader = await screen.findByTestId('group-header-row-status-todo');
    expect(doneHeader).toBeInTheDocument();
    expect(todoHeader).toBeInTheDocument();

    // Page-2 guard: 'done' shows 148 (endpoint), though only 2 'done' rows loaded.
    expect(within(doneHeader).getByText(/148 items/)).toBeInTheDocument();
    expect(within(todoHeader).getByText(/43 items/)).toBeInTheDocument();
  });

  it("renders each group's loaded TableRows under its header", async () => {
    vi.stubGlobal('fetch', makeGroupedFetch(listView));
    const { queryClient, router } = setup('/w/acme/p/web/work-items');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('Done one')).toBeInTheDocument());
    expect(screen.getByText('Done two')).toBeInTheDocument();
    expect(screen.getByText('Todo one')).toBeInTheDocument();
  });

  it('renders the ungrouped bucket LAST', async () => {
    vi.stubGlobal('fetch', makeGroupedFetch(listView));
    const { queryClient, router } = setup('/w/acme/p/web/work-items');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const ungrouped = await screen.findByTestId('group-header-row-status-__nogroup__');
    expect(ungrouped).toBeInTheDocument();
    expect(screen.getByText('No status item')).toBeInTheDocument();

    // The ungrouped header is the LAST group header in document order.
    const headers = screen.getAllByTestId(/^group-header-row-status-/);
    expect(headers[headers.length - 1]).toBe(ungrouped);
  });

  it('collapsing a group hides its rows but keeps the header (and its count)', async () => {
    vi.stubGlobal('fetch', makeGroupedFetch(listView));
    const { queryClient, router } = setup('/w/acme/p/web/work-items');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const doneHeader = await screen.findByTestId('group-header-row-status-done');
    expect(screen.getByText('Done one')).toBeInTheDocument();

    const chevron = within(doneHeader).getByRole('button', { name: /collapse group/i });
    await act(async () => {
      fireEvent.click(chevron);
    });

    // Rows gone, header + count still present.
    await waitFor(() => expect(screen.queryByText('Done one')).toBeNull());
    expect(screen.queryByText('Done two')).toBeNull();
    expect(screen.getByTestId('group-header-row-status-done')).toBeInTheDocument();
    expect(within(doneHeader).getByText(/148 items/)).toBeInTheDocument();
    // Other groups' rows are unaffected.
    expect(screen.getByText('Todo one')).toBeInTheDocument();
  });

  it('a type:table view renders FLAT — no group headers (regression guard)', async () => {
    vi.stubGlobal('fetch', makeGroupedFetch(tableView));
    const { queryClient, router } = setup('/w/acme/p/web/work-items');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('Done one')).toBeInTheDocument());
    // Flat: rows render, but NO group section headers exist.
    expect(screen.queryByTestId(/^group-header-row-/)).toBeNull();
  });
});
