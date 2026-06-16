import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Capture the props TableView / KanbanView are mounted with — the seam under
// test is "the :tslug route param reaches the view as the tslug prop". We mock
// the views (not the route) so the assertion is about the wire, not the views'
// data-fetch chain.
const tableSpy = vi.fn();
vi.mock('../components/table/table-view.tsx', () => ({
  TableView: (props: { wslug: string; pslug: string; tslug: string }) => {
    tableSpy(props);
    return <div data-testid="table-view">table {props.tslug}</div>;
  },
}));
const kanbanSpy = vi.fn();
vi.mock('../components/views/kanban-view.tsx', () => ({
  KanbanView: (props: { wslug: string; pslug: string; tslug: string }) => {
    kanbanSpy(props);
    return <div data-testid="kanban-view">kanban {props.tslug}</div>;
  },
}));

// The unified /t/$tslug route now renders <ViewRouter>, which resolves the
// active view via useActiveView → useViews (real react-query, unmocked in this
// harness → perpetual loading). Mock useActiveView so ViewRouter deterministically
// routes to the (mocked) TableView and the :tslug param-passthrough seam still
// asserts — the behavior-preservation proof for the two grid-route tests below.
vi.mock('../lib/api/use-active-view.ts', () => ({
  useActiveView: () => ({
    view: { id: 'v1', type: 'table' },
    views: [],
    isLoading: false,
  }),
}));

import { Route as BoardRoute } from './w.$wslug.p.$pslug.board.tsx';
import { Route as TableBoardRoute } from './w.$wslug.p.$pslug.t.$tslug.board.tsx';
// Imported AFTER the mocks so the route's `import { TableView }` resolves to the stub.
import { Route as TableTableRoute } from './w.$wslug.p.$pslug.t.$tslug.tsx';
import { Route as WorkItemsRoute } from './w.$wslug.p.$pslug.work-items.tsx';

const searchSchema = z.object({
  doc: z.string().optional(),
  view: z.string().optional(),
});

/**
 * Build a memory router whose tree always contains the unified /t/$tslug target
 * route (rendering the route under test's real component), plus the legacy
 * redirect routes (their real `beforeLoad`/`component` options). Navigating to a
 * legacy path exercises the redirect end-to-end: the resolved render must be the
 * unified route's mocked TableView, never a NotFound.
 */
function setupRouter(initialPath: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const notFoundRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '*',
    component: () => <div data-testid="not-found">not found</div>,
  });
  const tableRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/t/$tslug',
    validateSearch: searchSchema,
    component: TableTableRoute.options.component,
  });
  const tableBoardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/t/$tslug/board',
    validateSearch: searchSchema,
    beforeLoad: TableBoardRoute.options.beforeLoad,
    component: TableBoardRoute.options.component,
  });
  const workItemsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/work-items',
    validateSearch: searchSchema,
    beforeLoad: WorkItemsRoute.options.beforeLoad,
    component: WorkItemsRoute.options.component,
  });
  const boardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/board',
    validateSearch: searchSchema,
    beforeLoad: BoardRoute.options.beforeLoad,
    component: BoardRoute.options.component,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      tableRoute,
      tableBoardRoute,
      workItemsRoute,
      boardRoute,
      notFoundRoute,
    ]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  return { queryClient, router };
}

function renderRouter(initialPath: string) {
  const { queryClient, router } = setupRouter(initialPath);
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('/t/$tslug grid route', () => {
  afterEach(() => {
    tableSpy.mockClear();
    kanbanSpy.mockClear();
  });

  it('passes the :tslug route param through to TableView (via ViewRouter)', async () => {
    renderRouter('/w/acme/p/sales/t/bugs');

    expect(await screen.findByTestId('table-view')).toHaveTextContent('table bugs');
    expect(tableSpy).toHaveBeenCalledWith(
      expect.objectContaining({ wslug: 'acme', pslug: 'sales', tslug: 'bugs' }),
    );
  });

  it('does not collapse a non-default tslug to the default', async () => {
    renderRouter('/w/acme/p/sales/t/work-items');

    await screen.findByTestId('table-view');
    // Negative/adversarial: the route must carry the REAL param, never a hardcoded
    // default. A regression that hardcoded tslug="bugs" would pass the happy test
    // above; this asserts the param is the source of truth.
    expect(tableSpy).toHaveBeenCalledWith(expect.objectContaining({ tslug: 'work-items' }));
  });
});

describe('legacy URL redirects (back-compat — must NOT 404)', () => {
  afterEach(() => {
    tableSpy.mockClear();
    kanbanSpy.mockClear();
  });

  it('/work-items redirects to /t/work-items preserving ?view=', async () => {
    const router = renderRouter('/w/acme/p/sales/work-items?view=v1');

    expect(await screen.findByTestId('table-view')).toHaveTextContent('table work-items');
    expect(screen.queryByTestId('not-found')).toBeNull();
    // Resolved to the unified table route, default tslug, search preserved.
    expect(router.state.location.pathname).toBe('/w/acme/p/sales/t/work-items');
    expect(router.state.location.search).toMatchObject({ view: 'v1' });
    expect(tableSpy).toHaveBeenCalledWith(expect.objectContaining({ tslug: 'work-items' }));
  });

  it('/board redirects to /t/work-items (default table) preserving ?view=', async () => {
    const router = renderRouter('/w/acme/p/sales/board?view=v1');

    expect(await screen.findByTestId('table-view')).toHaveTextContent('table work-items');
    expect(screen.queryByTestId('not-found')).toBeNull();
    expect(router.state.location.pathname).toBe('/w/acme/p/sales/t/work-items');
    expect(router.state.location.search).toMatchObject({ view: 'v1' });
  });

  it('/t/$tslug/board redirects to /t/$tslug preserving the real tslug param', async () => {
    const router = renderRouter('/w/acme/p/sales/t/bugs/board?view=v2');

    expect(await screen.findByTestId('table-view')).toHaveTextContent('table bugs');
    expect(screen.queryByTestId('not-found')).toBeNull();
    // Param preserved — the deep board URL lands on the SAME table, not the default.
    expect(router.state.location.pathname).toBe('/w/acme/p/sales/t/bugs');
    expect(router.state.location.search).toMatchObject({ view: 'v2' });
    expect(tableSpy).toHaveBeenCalledWith(expect.objectContaining({ tslug: 'bugs' }));
  });
});
