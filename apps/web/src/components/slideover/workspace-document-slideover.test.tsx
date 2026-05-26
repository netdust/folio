import { describe, it, expect, afterEach, vi } from 'vitest';
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
import { WorkspaceDocumentSlideover } from './workspace-document-slideover.tsx';

function setup(initialSearch: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workspace = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug',
    validateSearch: z.object({
      doc: z.string().optional(),
    }),
    component: () => {
      const { wslug } = workspace.useParams();
      return (
        <>
          <div>workspace body</div>
          <WorkspaceDocumentSlideover wslug={wslug} />
        </>
      );
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([workspace]),
    history: createMemoryHistory({ initialEntries: [`/w/main${initialSearch}`] }),
  });
  return { queryClient, router };
}

function mockWorkspaceDoc(slug: string, type: 'agent' | 'trigger' = 'agent') {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      if (u.includes(`/w/main/documents/${slug}`)) {
        return new Response(
          JSON.stringify({
            data: {
              id: 'd1',
              slug,
              type,
              title: 'Triage Agent',
              status: null,
              parentId: null,
              frontmatter: { description: 'Sorts inbound issues' },
              body: '# Instructions\n\nDo the triage.',
              createdAt: '2026-01-01',
              updatedAt: '2026-01-02',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

describe('WorkspaceDocumentSlideover', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('is closed by default (no ?doc=)', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>());
    const { queryClient, router } = setup('');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('workspace body')).toBeInTheDocument());
    expect(screen.queryByText('Triage Agent')).not.toBeInTheDocument();
  });

  it('opens and fetches when ?doc= is set', async () => {
    mockWorkspaceDoc('triage', 'agent');
    const { queryClient, router } = setup('?doc=triage');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('Triage Agent')).toBeInTheDocument());
    expect(screen.getByText(/Do the triage\./)).toBeInTheDocument();
  });

  it('renders the TabStrip with Fields / Activity / Runs for an agent', async () => {
    mockWorkspaceDoc('triage', 'agent');
    const { queryClient, router } = setup('?doc=triage');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');

    const tablist = document.querySelector('[role="tablist"]');
    expect(tablist).not.toBeNull();
    const labels = Array.from(tablist!.querySelectorAll('[role="tab"]')).map(
      (t) => t.textContent ?? '',
    );
    expect(labels.some((l) => l.includes('Fields'))).toBe(true);
    expect(labels.some((l) => l.includes('Activity'))).toBe(true);
    expect(labels.some((l) => l.includes('Runs'))).toBe(true);
    // No Comments tab on workspace-scoped slideover.
    expect(labels.some((l) => l.includes('Comments'))).toBe(false);
  });

  it('renders the TabStrip with Fields / Activity / Runs for a trigger', async () => {
    mockWorkspaceDoc('webhook-orders', 'trigger');
    const { queryClient, router } = setup('?doc=webhook-orders');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');

    const tablist = document.querySelector('[role="tablist"]');
    expect(tablist).not.toBeNull();
    const labels = Array.from(tablist!.querySelectorAll('[role="tab"]')).map(
      (t) => t.textContent ?? '',
    );
    expect(labels.some((l) => l.includes('Fields'))).toBe(true);
    expect(labels.some((l) => l.includes('Activity'))).toBe(true);
    expect(labels.some((l) => l.includes('Runs'))).toBe(true);
    expect(labels.some((l) => l.includes('Comments'))).toBe(false);
  });

  it('defaults to the Fields tab on open', async () => {
    mockWorkspaceDoc('triage', 'agent');
    const { queryClient, router } = setup('?doc=triage');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');

    const tablist = document.querySelector('[role="tablist"]')!;
    const fieldsBtn = Array.from(tablist.querySelectorAll('[role="tab"]')).find(
      (t) => (t.textContent ?? '').includes('Fields'),
    );
    expect(fieldsBtn).toBeDefined();
    expect(fieldsBtn!.getAttribute('aria-pressed')).toBe('true');
  });

  it('switching to Activity renders the C10 placeholder; body editor still visible', async () => {
    mockWorkspaceDoc('triage', 'agent');
    const { queryClient, router } = setup('?doc=triage');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');

    expect(screen.queryByText(/Activity tab — wired in C10/)).toBeNull();

    const tablist = document.querySelector('[role="tablist"]')!;
    const activityBtn = Array.from(tablist.querySelectorAll('[role="tab"]')).find(
      (t) => (t.textContent ?? '').includes('Activity'),
    ) as HTMLElement;
    await userEvent.click(activityBtn);

    await waitFor(() => {
      expect(screen.getByText(/Activity tab — wired in C10/)).toBeInTheDocument();
    });
    expect(document.querySelector('[data-testid="workspace-slideover-editor"]')).not.toBeNull();
  });

  it('switching to Runs renders the Phase 3 placeholder; body editor still visible', async () => {
    mockWorkspaceDoc('triage', 'agent');
    const { queryClient, router } = setup('?doc=triage');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');

    expect(screen.queryByText(/No runs yet — Phase 3 wires the runner/)).toBeNull();

    const tablist = document.querySelector('[role="tablist"]')!;
    const runsBtn = Array.from(tablist.querySelectorAll('[role="tab"]')).find(
      (t) => (t.textContent ?? '').includes('Runs'),
    ) as HTMLElement;
    await userEvent.click(runsBtn);

    await waitFor(() => {
      expect(screen.getByText(/No runs yet — Phase 3 wires the runner/)).toBeInTheDocument();
    });
    expect(document.querySelector('[data-testid="workspace-slideover-editor"]')).not.toBeNull();
  });

  it('body editor stays visible across all tab switches', async () => {
    mockWorkspaceDoc('triage', 'agent');
    const { queryClient, router } = setup('?doc=triage');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');

    const tablist = document.querySelector('[role="tablist"]')!;
    const allTabs = Array.from(tablist.querySelectorAll('[role="tab"]')) as HTMLElement[];
    for (const t of allTabs) {
      await userEvent.click(t);
      expect(document.querySelector('[data-testid="workspace-slideover-editor"]')).not.toBeNull();
    }
  });
});
