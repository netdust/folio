import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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
import { TableView } from './table-view.tsx';

function setup(initialEntry = '/w/acme/p/web/work-items') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const work = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/work-items',
    validateSearch: z.object({
      doc: z.string().optional(),
      view: z.string().optional(),
      status: z.union([z.string(), z.array(z.string())]).optional(),
      priority: z.string().optional(),
      sort: z.string().optional(),
      dir: z.string().optional(),
    }),
    component: () => {
      const { wslug, pslug } = work.useParams();
      return <TableView wslug={wslug} pslug={pslug} />;
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

describe('TableView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

    const { queryClient, router } = setup();
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
