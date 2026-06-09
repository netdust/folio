import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

// Imported AFTER the mocks so the route's `import { TableView }` resolves to the stub.
import { Route as TableTableRoute } from './w.$wslug.p.$pslug.t.$tslug.tsx';
import { Route as TableBoardRoute } from './w.$wslug.p.$pslug.t.$tslug.board.tsx';

function setupRouter(initialPath: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const tableRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/t/$tslug',
    validateSearch: z.object({ doc: z.string().optional() }),
    component: TableTableRoute.options.component,
  });
  const boardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/t/$tslug/board',
    validateSearch: z.object({ doc: z.string().optional() }),
    component: TableBoardRoute.options.component,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([tableRoute, boardRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  return { queryClient, router };
}

describe('/t/$tslug grid route', () => {
  afterEach(() => {
    tableSpy.mockClear();
    kanbanSpy.mockClear();
    vi.restoreAllMocks();
  });

  it('passes the :tslug route param through to TableView', async () => {
    const { queryClient, router } = setupRouter('/w/acme/p/sales/t/bugs');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId('table-view')).toHaveTextContent('table bugs');
    expect(tableSpy).toHaveBeenCalledWith(
      expect.objectContaining({ wslug: 'acme', pslug: 'sales', tslug: 'bugs' }),
    );
  });

  it('does not collapse a non-default tslug to the default', async () => {
    const { queryClient, router } = setupRouter('/w/acme/p/sales/t/work-items');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await screen.findByTestId('table-view');
    // Negative/adversarial: the route must carry the REAL param, never a hardcoded
    // default. A regression that hardcoded tslug="bugs" would pass the happy test
    // above; this asserts the param is the source of truth.
    expect(tableSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tslug: 'work-items' }),
    );
  });
});

describe('/t/$tslug/board kanban route', () => {
  afterEach(() => {
    tableSpy.mockClear();
    kanbanSpy.mockClear();
    vi.restoreAllMocks();
  });

  it('passes the :tslug route param through to KanbanView', async () => {
    const { queryClient, router } = setupRouter('/w/acme/p/sales/t/bugs/board');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId('kanban-view')).toHaveTextContent('kanban bugs');
    expect(kanbanSpy).toHaveBeenCalledWith(
      expect.objectContaining({ wslug: 'acme', pslug: 'sales', tslug: 'bugs' }),
    );
  });
});
