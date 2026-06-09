import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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
import { z } from 'zod';
import { WorkspaceLayout } from './w.$wslug.tsx';

// Shared mock fixtures —————————————————————————————————————————

const me = { id: 'u1', email: 'stefan@x', name: 'Stefan' };
const workspace = { id: 'w1', slug: 'acme', name: 'Acme' };
const projects = [{ id: 'p1', slug: 'sales', name: 'Sales' }];
const tables = [{ id: 't1', slug: 'work-items', name: 'Work Items' }];
const views = [
  { id: 'v-default', slug: 'all', name: 'All', type: 'list', filters: {}, sort: [], groupBy: null, visibleFields: [], columnOrder: null, isDefault: true, order: 0 },
  { id: 'v-triage', slug: 'triage', name: 'Triage', type: 'list', filters: { status: 'In Progress' }, sort: [], groupBy: null, visibleFields: [], columnOrder: null, isDefault: false, order: 10 },
];

interface SetupOpts {
  initialPath?: string;
  /** Captures every fetch call so individual tests can introspect / assert. */
  onFetch?: (url: string, init?: RequestInit) => void;
}

/**
 * Mounts WorkspaceLayout under a memory router with the same path shape
 * the real file route uses. Stubs `fetch` with sane defaults — tests can
 * pass `onFetch` to layer extra behavior on top.
 */
function setup({ initialPath = '/w/acme/p/sales/work-items', onFetch }: SetupOpts = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    const u = String(url);
    onFetch?.(u, init);

    const respond = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (u.endsWith('/api/v1/auth/me')) return respond({ data: { user: me } });
    if (u.endsWith(`/api/v1/w/${workspace.slug}`)) return respond({ data: workspace });
    if (u.endsWith('/api/v1/workspaces')) {
      return respond({ data: [{ workspace, role: 'owner' }] });
    }
    if (u.endsWith(`/api/v1/w/${workspace.slug}/projects`)) return respond({ data: projects });
    if (u.endsWith(`/api/v1/w/${workspace.slug}/p/sales`)) return respond({ data: projects[0] });
    if (u.endsWith(`/api/v1/w/${workspace.slug}/p/sales/tables`)) return respond({ data: tables });
    // Views are now fetched per (project, table): /p/sales/t/<tslug>/views.
    if (/\/p\/sales\/t\/[^/]+\/views$/.test(u)) return respond({ data: views });
    if (u.endsWith(`/api/v1/w/${workspace.slug}/p/sales/statuses`)) return respond({ data: [] });
    if (u.endsWith(`/api/v1/w/${workspace.slug}/p/sales/fields`)) return respond({ data: [] });
    if (u.includes(`/api/v1/w/${workspace.slug}/p/sales/documents`)) {
      return respond({ data: { data: [], nextCursor: null } });
    }
    // The layout now mounts <WorkspaceDocumentSlideover>, which fetches the
    // workspace doc + its events whenever ?doc=<slug> is present. Tests that
    // start with ?doc= (e.g. preserving it across a view switch) would
    // otherwise hit the catch-all `{}` and crash FrontmatterForm on a missing
    // `data` envelope. Order matters: the /events suffix is matched first.
    if (/\/w\/[^/]+\/documents\/[^/]+\/events$/.test(u)) {
      return respond({ data: [] });
    }
    if (u.includes(`/w/${workspace.slug}/documents?`)) {
      return respond({ data: [] });
    }
    if (/\/w\/[^/]+\/documents\/[^/?]+/.test(u)) {
      return respond({
        data: {
          id: 'd-doc',
          slug: 'lead-foo',
          type: 'work_item',
          title: 'Lead Foo',
          status: null,
          parentId: null,
          frontmatter: {},
          body: '',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-02',
        },
      });
    }
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });

    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);

  // Routes: root → workspace ($wslug) → project ($pslug) → work-items.
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workspaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug',
    validateSearch: z.object({
      doc: z.string().optional(),
      view: z.string().optional(),
      status: z.union([z.string(), z.array(z.string())]).optional(),
      priority: z.string().optional(),
      sort: z.string().optional(),
      dir: z.string().optional(),
    }),
    component: WorkspaceLayout,
  });
  const projectRoute = createRoute({
    getParentRoute: () => workspaceRoute,
    path: 'p/$pslug',
    component: () => <Outlet />,
  });
  const workItemsRoute = createRoute({
    getParentRoute: () => projectRoute,
    path: 'work-items',
    component: () => <div data-testid="work-items">work items</div>,
  });

  const router = createRouter({
    routeTree: rootRoute.addChildren([
      workspaceRoute.addChildren([projectRoute.addChildren([workItemsRoute])]),
    ]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });

  return { queryClient, router, fetchMock };
}

// The layout now mounts the provider-health + reactor-halt banners, whose
// E-2b hooks open an EventSource. jsdom has none, so stub a no-op constructor.
class NoopEventSource {
  constructor(_url: string) {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

describe('WorkspaceLayout — delete + nav side effects', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('EventSource', NoopEventSource as unknown as typeof EventSource);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('clicking a view in the rail preserves other URL params (e.g. ?doc=<slug>)', async () => {
    // User is mid-edit with the slideover open (?doc=lead-foo). They click
    // another view in the rail. The view should change but the slideover
    // shouldn't slam shut.
    localStorage.setItem('folio:rail-expanded:table:sales:work-items', '1');
    const { queryClient, router } = setup({
      initialPath: '/w/acme/p/sales/work-items?doc=lead-foo&status=open',
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText('Triage')).toBeInTheDocument());

    // REGRESSION (dual-modal collision): ?doc= is the PROJECT slideover's param.
    // The layout-mounted WorkspaceDocumentSlideover now reads ?wdoc=, so a
    // work-item ?doc=lead-foo must NOT open the workspace slideover (it would
    // 404 on a work-item slug and stack a second focus-trapping modal). With
    // the workspace slideover staying closed, there's no Radix
    // pointer-events:none overlay, so userEvent can click normally.
    expect(screen.queryByText('Failed to load')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Triage'));

    await waitFor(() => {
      const s = router.state.location.search as Record<string, unknown>;
      expect(s.view).toBe('v-triage');
      // doc must NOT be wiped just because the user changed views.
      expect(s.doc).toBe('lead-foo');
    });
  });

  it('new-view sheet captures columns from the table its "+" was clicked on, not work-items', async () => {
    // 2-table project: the DEFAULT (work-items) and a non-default `bugs` table,
    // each with a distinct default-view column set. Opening "+ new view" under
    // `bugs` must seed the new view from BUGS' columns — not work-items' (the
    // first/default table). The bug: newViewCurrentColumns read tables[0].
    const twoTables = [
      { id: 't1', slug: 'work-items', name: 'Work Items' },
      { id: 't2', slug: 'bugs', name: 'Bugs' },
    ];
    const workItemsViews = [
      { id: 'v-wi', slug: 'all', name: 'All', type: 'list', filters: {}, sort: [], groupBy: null, visibleFields: ['title', 'status'], columnOrder: ['title', 'status'], isDefault: true, order: 0 },
    ];
    const bugsViews = [
      { id: 'v-bugs', slug: 'all', name: 'All', type: 'list', filters: {}, sort: [], groupBy: null, visibleFields: ['title', 'severity', 'repro'], columnOrder: ['title', 'severity', 'repro'], isDefault: true, order: 0 },
    ];

    let createdViewBody: Record<string, unknown> | undefined;
    const { queryClient, router } = setup({
      onFetch: (u, init) => {
        if (init?.method === 'POST' && /\/p\/sales\/t\/bugs\/views$/.test(u)) {
          createdViewBody = JSON.parse(String(init.body));
        }
      },
    });

    // Re-stub fetch with the 2-table fixture (setup's default is 1 table).
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      if (init?.method === 'POST' && /\/p\/sales\/t\/bugs\/views$/.test(u)) {
        createdViewBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ data: { id: 'v-new', type: 'list' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const respond = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
      if (u.endsWith('/api/v1/auth/me')) return respond({ data: { user: me } });
      if (u.endsWith(`/api/v1/w/${workspace.slug}`)) return respond({ data: workspace });
      if (u.endsWith('/api/v1/workspaces')) return respond({ data: [{ workspace, role: 'owner' }] });
      if (u.endsWith(`/api/v1/w/${workspace.slug}/projects`)) return respond({ data: projects });
      if (u.endsWith(`/api/v1/w/${workspace.slug}/p/sales/tables`)) return respond({ data: twoTables });
      if (/\/p\/sales\/t\/work-items\/views$/.test(u)) return respond({ data: workItemsViews });
      if (/\/p\/sales\/t\/bugs\/views$/.test(u)) return respond({ data: bugsViews });
      if (/\/p\/sales\/t\/[^/]+\/fields$/.test(u)) return respond({ data: [] });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    // Wait for the Bugs table row to render in the rail.
    const bugsLabel = await screen.findByText('Bugs');
    const bugsRow = bugsLabel.closest('li')!;
    const plusBtn = bugsRow.querySelector('[data-testid="rail-tree-plus"]') as HTMLElement;
    fireEvent.click(plusBtn);

    // Sheet opens; name it and create.
    const nameInput = await screen.findByLabelText('Name');
    fireEvent.change(nameInput, { target: { value: 'My Bugs View' } });
    fireEvent.click(screen.getByRole('button', { name: /Create view/i }));

    await waitFor(() => expect(createdViewBody).toBeDefined());
    // The captured columns must be BUGS' columns, never work-items'.
    expect(createdViewBody!.visibleFields).toEqual(['title', 'severity', 'repro']);
    expect(createdViewBody!.columnOrder).toEqual(['title', 'severity', 'repro']);
  });

  it('strips ?view=<id> from URL when the active view is deleted', async () => {
    // Force the Work Items branch open so the Triage view row is visible.
    localStorage.setItem('folio:rail-expanded:table:sales:work-items', '1');

    const { queryClient, router } = setup({
      initialPath: '/w/acme/p/sales/work-items?view=v-triage',
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    // Wait for the rail to render the Triage view row.
    await waitFor(() => expect(screen.getByText('Triage')).toBeInTheDocument());

    // Open Triage's row menu and click Delete.
    const triageRow = screen.getByText('Triage').closest('li')!;
    const menuBtn = triageRow.querySelector('[data-testid="rail-tree-menu"]') as HTMLElement;
    await userEvent.click(menuBtn);
    await userEvent.click(await screen.findByRole('menuitem', { name: /Delete/ }));

    // Confirm-delete dialog → Delete button.
    const confirmBtn = await screen.findByRole('button', { name: /^Delete$/i });
    await userEvent.click(confirmBtn);

    await waitFor(() => {
      const s = router.state.location.search as Record<string, unknown>;
      expect(s.view).toBeUndefined();
    });
  });
});
