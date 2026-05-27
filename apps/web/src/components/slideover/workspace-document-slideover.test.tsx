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

function mockWorkspaceDoc(
  slug: string,
  type: 'agent' | 'trigger' = 'agent',
  options: {
    frontmatter?: Record<string, unknown>;
    title?: string;
    body?: string;
    onPatch?: (body: unknown) => void;
  } = {},
) {
  const title = options.title ?? 'Triage Agent';
  const body = options.body ?? '# Instructions\n\nDo the triage.';
  const frontmatter =
    options.frontmatter ?? { description: 'Sorts inbound issues' };
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      // The events endpoint is a suffix-match so it must be checked BEFORE
      // the generic doc-detail match (which also covers /events).
      if (u.endsWith(`/w/main/documents/${slug}/events`)) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // Workspace agents/triggers list (used by TriggerForm's agent dropdown).
      if (u.includes('/w/main/documents?')) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes(`/w/main/documents/${slug}`)) {
        if (method === 'PATCH' && options.onPatch) {
          try {
            const parsed = init?.body ? JSON.parse(String(init.body)) : null;
            options.onPatch(parsed);
          } catch {
            options.onPatch(init?.body);
          }
        }
        return new Response(
          JSON.stringify({
            data: {
              id: 'd1',
              slug,
              type,
              title,
              status: null,
              parentId: null,
              frontmatter,
              body,
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

  it('switching to Activity renders the workspace Activity panel + Log button (agent); body editor still visible', async () => {
    mockWorkspaceDoc('triage', 'agent');
    const { queryClient, router } = setup('?doc=triage');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');

    // The C9 placeholder is gone.
    expect(screen.queryByText(/Activity tab — wired in C10/)).toBeNull();

    const tablist = document.querySelector('[role="tablist"]')!;
    const activityBtn = Array.from(tablist.querySelectorAll('[role="tab"]')).find(
      (t) => (t.textContent ?? '').includes('Activity'),
    ) as HTMLElement;
    await userEvent.click(activityBtn);

    // Real Activity panel renders ("No activity yet." for the empty-events mock).
    await waitFor(() => {
      expect(screen.getByText('No activity yet.')).toBeInTheDocument();
    });
    // Log Activity button is shown for agent docs.
    expect(screen.getByRole('button', { name: /Log activity/ })).toBeInTheDocument();
    expect(document.querySelector('[data-testid="workspace-slideover-editor"]')).not.toBeNull();
  });

  it('Activity tab on a trigger renders the panel WITHOUT the Log button', async () => {
    mockWorkspaceDoc('webhook', 'trigger');
    const { queryClient, router } = setup('?doc=webhook');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');

    const tablist = document.querySelector('[role="tablist"]')!;
    const activityBtn = Array.from(tablist.querySelectorAll('[role="tab"]')).find(
      (t) => (t.textContent ?? '').includes('Activity'),
    ) as HTMLElement;
    await userEvent.click(activityBtn);

    await waitFor(() => {
      expect(screen.getByText('No activity yet.')).toBeInTheDocument();
    });
    // A7 rejects activity-logging for triggers — the button must be HIDDEN
    // (not just disabled). Triggers' runs surface on the Runs tab in Phase 3.
    expect(screen.queryByRole('button', { name: /Log activity/ })).toBeNull();
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

  it('trigger slideover Fields tab renders TriggerForm (not FrontmatterForm)', async () => {
    mockWorkspaceDoc('webhook-orders', 'trigger', {
      title: 'Triage Agent',
      frontmatter: {
        schedule: '0 9 * * *',
        on_event: null,
        agent: null,
        enabled: true,
      },
    });
    const { queryClient, router } = setup('?doc=webhook-orders');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');

    // TriggerForm-specific affordances: mode radios labelled Schedule / Event.
    expect(await screen.findByLabelText(/^schedule$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^event$/i)).toBeInTheDocument();

    // FrontmatterForm's "Add field" affordance must be absent.
    expect(screen.queryByRole('button', { name: /Add field/i })).toBeNull();
  });

  it('agent slideover Fields tab still renders FrontmatterForm (not TriggerForm)', async () => {
    mockWorkspaceDoc('triage', 'agent');
    const { queryClient, router } = setup('?doc=triage');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');

    // TriggerForm-specific affordances must NOT be present for agents.
    expect(screen.queryByLabelText(/^schedule$/i)).toBeNull();
    expect(screen.queryByLabelText(/^event$/i)).toBeNull();

    // FrontmatterForm's "Add field" affordance must be present.
    expect(screen.getByRole('button', { name: /Add field/i })).toBeInTheDocument();
  });

  it('trigger slideover Save button is disabled until a change is made', async () => {
    mockWorkspaceDoc('webhook-orders', 'trigger', {
      title: 'Triage Agent',
      frontmatter: {
        schedule: '0 9 * * *',
        on_event: null,
        agent: null,
        enabled: true,
      },
    });
    const { queryClient, router } = setup('?doc=webhook-orders');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');

    const saveBtn = (await screen.findByRole('button', {
      name: /^save$/i,
    })) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);

    // Toggle the Enabled checkbox to dirty the draft.
    const enabledCb = screen.getByLabelText(/^enabled$/i) as HTMLInputElement;
    await userEvent.click(enabledCb);

    await waitFor(() => expect(saveBtn.disabled).toBe(false));
  });

  it('trigger slideover Save button calls PATCH with changed fields on click', async () => {
    const patches: unknown[] = [];
    mockWorkspaceDoc('webhook-orders', 'trigger', {
      title: 'Triage Agent',
      frontmatter: {
        schedule: '0 9 * * *',
        on_event: null,
        agent: null,
        enabled: true,
      },
      onPatch: (body) => patches.push(body),
    });
    const { queryClient, router } = setup('?doc=webhook-orders');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');

    const enabledCb = await screen.findByLabelText(/^enabled$/i);
    await userEvent.click(enabledCb);

    const saveBtn = await screen.findByRole('button', { name: /^save$/i });
    await userEvent.click(saveBtn);

    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    const patch = patches[patches.length - 1] as { frontmatter?: Record<string, unknown> };
    expect(patch.frontmatter).toBeDefined();
    // Only the toggled field's value changed: enabled is now false.
    expect(patch.frontmatter!.enabled).toBe(false);
  });

  it('builtin trigger slideover Save sends only the toggled Enabled field', async () => {
    const patches: unknown[] = [];
    mockWorkspaceDoc('repo-import', 'trigger', {
      title: 'Triage Agent',
      frontmatter: {
        builtin: true,
        schedule: '0 9 * * *',
        on_event: null,
        agent: null,
        enabled: true,
      },
      onPatch: (body) => patches.push(body),
    });
    const { queryClient, router } = setup('?doc=repo-import');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');

    // Mode radios should be disabled for builtin triggers (D6 lock).
    const scheduleRadio = (await screen.findByLabelText(/^schedule$/i)) as HTMLInputElement;
    const eventRadio = screen.getByLabelText(/^event$/i) as HTMLInputElement;
    expect(scheduleRadio.disabled).toBe(true);
    expect(eventRadio.disabled).toBe(true);

    // Toggle Enabled — this stays mutable for builtins.
    const enabledCb = screen.getByLabelText(/^enabled$/i);
    await userEvent.click(enabledCb);

    const saveBtn = await screen.findByRole('button', { name: /^save$/i });
    await waitFor(() => expect((saveBtn as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(saveBtn);

    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    const patch = patches[patches.length - 1] as { frontmatter?: Record<string, unknown> };
    expect(patch.frontmatter).toBeDefined();
    expect(patch.frontmatter!.enabled).toBe(false);
    // builtin and other frontmatter keys remain in the payload because we
    // send the merged frontmatter object — but the diff'd keys must include
    // `enabled` and exclude anything else that didn't change.
    expect(patch.frontmatter!.builtin).toBe(true);
  });
});
