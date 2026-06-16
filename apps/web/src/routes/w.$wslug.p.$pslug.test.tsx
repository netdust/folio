import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Route as ProjectFileRoute } from './w.$wslug.p.$pslug.tsx';

// ─── useLiveDocuments mount assertion ────────────────────────────────────────
const liveSpy = vi.fn();
vi.mock('@/lib/api/use-live-documents', () => ({
  useLiveDocuments: (...a: unknown[]) => liveSpy(...a),
}));

// Capture the props BoardControls is mounted with — the seam under test is
// "the active table reaches BoardControls as the tslug prop" (invariant 16:
// group-by/sort must persist to the table being viewed, not work-items).
const boardControlsSpy = vi.fn();
vi.mock('../components/kanban/board-controls.tsx', () => ({
  BoardControls: (props: { wslug: string; pslug: string; tslug: string }) => {
    boardControlsSpy(props);
    return <div data-testid="board-controls">controls {props.tslug}</div>;
  },
}));

// ─── Saved-view switcher: control the view list + active view ────────────────
// The project layout now drives its tabs off the saved views (useViews) and the
// active-view resolver (useActiveView), not a fixed Work-items/Board pair. Mock
// both so the switcher renders deterministically and the kanban gate is driven
// by the ACTIVE VIEW's type (invariant 16/18), not a board path.
interface MockView {
  id: string;
  name: string;
  type: 'table' | 'list' | 'kanban' | 'calendar' | 'timeline' | 'gallery';
  isDefault: boolean;
}
let mockViews: MockView[] = [
  { id: 'v1', name: 'All work items', type: 'list', isDefault: true },
  { id: 'v2', name: 'Board', type: 'kanban', isDefault: false },
];
let mockActiveView: MockView | undefined = mockViews[0];
vi.mock('../lib/api/views.ts', () => ({
  useViews: () => ({ data: mockViews }),
}));
vi.mock('../lib/api/use-active-view.ts', () => ({
  useActiveView: () => ({ view: mockActiveView, views: mockViews, isLoading: false }),
}));

// Shared mock fixtures —————————————————————————————————————————

const workspace = { id: 'w1', slug: 'acme', name: 'Acme' };
const project = { id: 'p1', slug: 'sales', name: 'Sales' };

function setup({ initialPath = '/w/acme/p/sales/work-items' }: { initialPath?: string } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  const fetchMock = vi.fn<typeof fetch>(async (url) => {
    const u = String(url);
    const respond = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (u.endsWith(`/api/v1/w/${workspace.slug}/p/sales`)) return respond({ data: project });
    // Documents are now table-scoped: /p/sales/t/<tslug>/documents. Match any
    // /documents under the project so the layout's count fetch resolves.
    if (u.includes(`/api/v1/w/${workspace.slug}/p/sales/`) && u.includes('/documents')) {
      return respond({ data: { data: [], nextCursor: null } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);

  // ProjectLayout is the component for /w/$wslug/p/$pslug. Mount it under a
  // memory router with the same path shape the real file route uses, with a
  // work-items leaf so `activeTab` resolves.
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug',
    validateSearch: z.object({ doc: z.string().optional() }),
    component: ProjectFileRoute.options.component,
  });
  const workItemsRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: 'work-items',
    component: () => <div data-testid="work-items">work items</div>,
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([projectRoute.addChildren([workItemsRoute])]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });

  return { queryClient, router };
}

// Variant: mount the layout under the /t/$tslug/board route so the layout
// resolves a NON-default tslug from the params (useCurrentTslug reads :tslug).
function setupTableBoard(initialPath: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const fetchMock = vi.fn<typeof fetch>(async (url) => {
    const u = String(url);
    const respond = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (u.endsWith(`/api/v1/w/${workspace.slug}/p/sales`)) return respond({ data: project });
    if (u.includes('/documents')) return respond({ data: { data: [], nextCursor: null } });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug',
    validateSearch: z.object({ doc: z.string().optional() }),
    component: ProjectFileRoute.options.component,
  });
  const tableBoardRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: 't/$tslug/board',
    component: () => <div data-testid="table-board">table board</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([projectRoute.addChildren([tableBoardRoute])]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  return { queryClient, router };
}

describe('ProjectLayout — table-aware BoardControls (invariant 16)', () => {
  beforeEach(() => {
    localStorage.clear();
    boardControlsSpy.mockClear();
    mockViews = [
      { id: 'v1', name: 'All work items', type: 'list', isDefault: true },
      { id: 'v2', name: 'Board', type: 'kanban', isDefault: false },
    ];
    mockActiveView = mockViews[0];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('when the active view is kanban, BoardControls receives the real tslug (not hardcoded work-items)', async () => {
    // Active view is the kanban one → BoardControls gate opens (invariant 18:
    // the gate is the ACTIVE VIEW's type, not a board path).
    mockActiveView = mockViews[1];
    const { queryClient, router } = setupTableBoard('/w/acme/p/sales/t/bugs/board');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('board-controls')).toBeInTheDocument());
    // Regression guard: a hardcoded tslug="work-items" would render "controls
    // work-items" here and the click would write group-by/sort to the WRONG table.
    expect(screen.getByTestId('board-controls')).toHaveTextContent('controls bugs');
    expect(boardControlsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ wslug: 'acme', pslug: 'sales', tslug: 'bugs' }),
    );
  });

  it('does NOT render BoardControls when the active view is not kanban (denial path)', async () => {
    // Active view is a list → the kanban gate stays closed even on a /board URL.
    mockActiveView = mockViews[0];
    const { queryClient, router } = setupTableBoard('/w/acme/p/sales/t/bugs/board');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    // The layout must have rendered (table-board leaf reachable) before asserting absence.
    await waitFor(() => expect(screen.getByTestId('table-board')).toBeInTheDocument());
    expect(screen.queryByTestId('board-controls')).toBeNull();
    expect(boardControlsSpy).not.toHaveBeenCalled();
  });
});

describe('ProjectLayout — header has no view switcher (rail owns saved views)', () => {
  beforeEach(() => {
    localStorage.clear();
    mockViews = [
      { id: 'v1', name: 'All work items', type: 'list', isDefault: true },
      { id: 'v2', name: 'Board', type: 'kanban', isDefault: false },
    ];
    mockActiveView = mockViews[0];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does NOT render a header tab per saved view (the rail is the sole saved-views surface)', async () => {
    const { queryClient, router } = setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    // Sanity: the project actually loaded (avoids passing on a "not found" screen).
    await waitFor(() => expect(screen.getByText('Sales')).toBeInTheDocument());

    // The header MUST NOT duplicate the rail's saved-view list — even though
    // mockViews has named views, no header tab renders for them (Stefan, 2026-06-16).
    expect(screen.queryByRole('tab', { name: /All work items/ })).toBeNull();
    expect(screen.queryByRole('tab', { name: /Board/ })).toBeNull();
  });

  it('shows a visible operator-panel toggle in the toolbar (G4)', async () => {
    const { queryClient, router } = setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('Sales')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /operator|assistant|panel/i })).toBeInTheDocument();
  });
});

describe('ProjectLayout — live document updates', () => {
  beforeEach(() => {
    localStorage.clear();
    liveSpy.mockClear();
    mockViews = [
      { id: 'v1', name: 'All work items', type: 'list', isDefault: true },
      { id: 'v2', name: 'Board', type: 'kanban', isDefault: false },
    ];
    mockActiveView = mockViews[0];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('mounts useLiveDocuments with wslug and pslug from the route params', async () => {
    const { queryClient, router } = setup({ initialPath: '/w/acme/p/sales/work-items' });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    // Wait for the route to render (project loaded) before asserting.
    await waitFor(() => expect(screen.getByText('Sales')).toBeInTheDocument());

    // wslug + pslug for the slug-keyed cache, project.id for the SSE filter
    // (the /events route matches ?project= by id, not slug).
    expect(liveSpy).toHaveBeenCalledWith('acme', 'sales', 'p1');
  });
});
