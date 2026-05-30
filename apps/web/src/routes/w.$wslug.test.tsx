import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
    if (u.endsWith(`/api/v1/w/${workspace.slug}/p/sales/views`)) return respond({ data: views });
    if (u.endsWith(`/api/v1/w/${workspace.slug}/p/sales/statuses`)) return respond({ data: [] });
    if (u.endsWith(`/api/v1/w/${workspace.slug}/p/sales/fields`)) return respond({ data: [] });
    if (u.includes(`/api/v1/w/${workspace.slug}/p/sales/documents`)) {
      return respond({ data: { data: [], nextCursor: null } });
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

    // Click "Triage" — fires onViewClick handler.
    await userEvent.click(screen.getByText('Triage'));

    await waitFor(() => {
      const s = router.state.location.search as Record<string, unknown>;
      expect(s.view).toBe('v-triage');
      // doc must NOT be wiped just because the user changed views.
      expect(s.doc).toBe('lead-foo');
    });
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
