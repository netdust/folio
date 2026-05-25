import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
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
  id: 's1', key: 'todo', name: 'Todo', color: '#3b82f6', category: 'unstarted' as const, order: 0,
};

const fieldRow = {
  id: 'f1', key: 'amount', type: 'currency', label: 'Amount', options: ['EUR'],
  required: false, order: 0,
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
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [viewRow] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200, headers: { 'content-type': 'application/json' },
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
        return new Response(
          JSON.stringify({ data: [statusRow] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(
          JSON.stringify({ data: [fieldRow] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(
          JSON.stringify({ data: [viewRow] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(
          JSON.stringify({ data: { data: [docRow], nextCursor: null } }),
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
    const currencyCell = screen.getByText((content) => /€/.test(content) && /1[\.,]250/.test(content));
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
        ? (v as (input: unknown) => Record<string, unknown>)({ sort: 'next_action_due', dir: 'asc' })
        : ((v as { parse: (input: unknown) => Record<string, unknown> }).parse({ sort: 'next_action_due', dir: 'asc' }));
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
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [customSortView] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200, headers: { 'content-type': 'application/json' },
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
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [triageView] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = setup(
      '/w/acme/p/web/work-items?view=v-triage&status=todo',
    );
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
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [defaultView, triageView] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200, headers: { 'content-type': 'application/json' },
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
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [defaultView] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.match(/\/views\/v-default/) && method === 'PATCH') {
        const body = await (init?.body instanceof ReadableStream
          ? new Response(init.body).text()
          : Promise.resolve(String(init?.body ?? '{}')));
        updateViewCalls.push({ id: 'v-default', patch: JSON.parse(body) });
        return new Response(JSON.stringify(defaultView), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200, headers: { 'content-type': 'application/json' },
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

    // Give any pending react-query mutations a chance to fire (none should).
    await new Promise((r) => setTimeout(r, 50));

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
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [defaultView] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.match(/\/views\/v-default/) && method === 'PATCH') {
        const body = await (init?.body instanceof ReadableStream
          ? new Response(init.body).text()
          : Promise.resolve(String(init?.body ?? '{}')));
        updateViewCalls.push({ id: 'v-default', patch: JSON.parse(body) });
        return new Response(JSON.stringify(defaultView), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200, headers: { 'content-type': 'application/json' },
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

    await new Promise((r) => setTimeout(r, 50));

    expect(updateViewCalls).toEqual([]);
  });

  it('renders an add-row at the end of the list when there are existing docs', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/statuses') && method === 'GET') {
        return new Response(JSON.stringify({ data: [statusRow] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [viewRow] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200, headers: { 'content-type': 'application/json' },
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
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [viewRow] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.endsWith('/documents') && method === 'POST') {
        const body = init?.body instanceof ReadableStream
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
          status: 200, headers: { 'content-type': 'application/json' },
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
    await act(async () => { fireEvent.click(trigger); });

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
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [viewRow] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.endsWith('/documents') && method === 'POST') {
        const body = init?.body instanceof ReadableStream
          ? await new Response(init.body).text()
          : String(init?.body ?? '{}');
        createCalls.push(JSON.parse(body));
        return new Response(JSON.stringify(docRow), { status: 201 });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200, headers: { 'content-type': 'application/json' },
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
    await act(async () => { fireEvent.click(trigger); });
    const input = await screen.findByRole('textbox', { name: /New work item title/ });
    await act(async () => {
      fireEvent.blur(input);
    });

    await new Promise((r) => setTimeout(r, 30));
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
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [viewRow] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200, headers: { 'content-type': 'application/json' },
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
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/fields') && method === 'GET') {
        return new Response(JSON.stringify({ data: [fieldRow] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views') && method === 'GET') {
        return new Response(JSON.stringify({ data: [mockView] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/views/v1') && method === 'PATCH') {
        const body = await (init?.body instanceof ReadableStream
          ? new Response(init.body).text()
          : Promise.resolve(String(init?.body ?? '{}')));
        updateViewCalls.push({ id: 'v1', patch: JSON.parse(body) });
        return new Response(JSON.stringify(mockView), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents') && method === 'GET') {
        return new Response(JSON.stringify({ data: { data: [docRow], nextCursor: null } }), {
          status: 200, headers: { 'content-type': 'application/json' },
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
      expect(updateViewCalls.some((call) =>
        Array.isArray(call.patch.sort) &&
        call.patch.sort.length === 1 &&
        call.patch.sort[0].key === 'title' &&
        call.patch.sort[0].dir === 'asc'
      )).toBe(true);
    });
  });
});
