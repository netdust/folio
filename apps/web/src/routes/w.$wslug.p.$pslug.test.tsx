import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
import { Route as ProjectFileRoute } from './w.$wslug.p.$pslug.tsx';

// ─── useLiveDocuments mount assertion ────────────────────────────────────────
const liveSpy = vi.fn();
vi.mock('@/lib/api/use-live-documents', () => ({ useLiveDocuments: (...a: unknown[]) => liveSpy(...a) }));

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
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
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
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('on /t/bugs/board, BoardControls receives the real tslug (not hardcoded work-items)', async () => {
    const { queryClient, router } = setupTableBoard('/w/acme/p/sales/t/bugs/board');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    // The Board tab is active on a /t/<tslug>/board path → BoardControls mounts.
    await waitFor(() => expect(screen.getByTestId('board-controls')).toBeInTheDocument());
    // Regression guard: a hardcoded tslug="work-items" would render "controls
    // work-items" here and the click would write group-by/sort to the WRONG table.
    expect(screen.getByTestId('board-controls')).toHaveTextContent('controls bugs');
    expect(boardControlsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ wslug: 'acme', pslug: 'sales', tslug: 'bugs' }),
    );
  });
});

describe('ProjectLayout — tab bar', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('project tab bar shows Work items and Board with icons, and no Wiki tab', async () => {
    const { queryClient, router } = setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('tab', { name: /work items/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /board/i })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /wiki/i })).toBeNull();
    expect(screen.getByRole('tab', { name: /work items/i }).querySelector('svg')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /board/i }).querySelector('svg')).toBeTruthy();

    // Sanity: the project actually loaded (avoids passing on a "not found" screen).
    await waitFor(() => expect(screen.getByText('Sales')).toBeInTheDocument());
  });
});

describe('ProjectLayout — live document updates', () => {
  beforeEach(() => {
    localStorage.clear();
    liveSpy.mockClear();
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
