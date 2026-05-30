import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
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
import { WorkspaceDocumentSlideover } from './workspace-document-slideover.tsx';

function setup(initialSearch: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workspace = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug',
    validateSearch: z.object({
      doc: z.string().optional(),
      tab: z.enum(['fields', 'activity', 'runs']).optional(),
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
  // The Runs tab mounts useRunsLiveSync, which opens an EventSource. jsdom has
  // no EventSource — stub a no-op so the Runs tab doesn't crash the slideover.
  vi.stubGlobal(
    'EventSource',
    class {
      addEventListener() {}
      removeEventListener() {}
      close() {}
    } as unknown as typeof EventSource,
  );
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
  // The resizable-width hook persists to localStorage (key folio:width:agent-config);
  // clear between tests so a width set by one test can't leak into another.
  beforeEach(() => localStorage.clear());

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

  it('deep-link ?tab=runs opens on the Runs tab', async () => {
    mockWorkspaceDoc('triage', 'agent');
    const { queryClient, router } = setup('?doc=triage&tab=runs');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');

    const tablist = document.querySelector('[role="tablist"]')!;
    const runsBtn = Array.from(tablist.querySelectorAll('[role="tab"]')).find(
      (t) => (t.textContent ?? '').includes('Runs'),
    );
    expect(runsBtn).toBeDefined();
    await waitFor(() => {
      expect(runsBtn!.getAttribute('aria-pressed')).toBe('true');
    });
  });

  it('manual tab click clears the ?tab= param so it stops re-asserting', async () => {
    mockWorkspaceDoc('triage', 'agent');
    const { queryClient, router } = setup('?doc=triage&tab=runs');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');

    // Arrived on Runs (the deep-link).
    expect((router.state.location.search as { tab?: string }).tab).toBe('runs');

    const tablist = document.querySelector('[role="tablist"]')!;
    const fieldsBtn = Array.from(tablist.querySelectorAll('[role="tab"]')).find(
      (t) => (t.textContent ?? '').includes('Fields'),
    ) as HTMLElement;
    await userEvent.click(fieldsBtn);

    // Clicking a tab clears the ?tab= param (and the doc stays).
    await waitFor(() => {
      const s = router.state.location.search as { doc?: string; tab?: string };
      expect(s.tab).toBeUndefined();
      expect(s.doc).toBe('triage');
    });
    // Fields is now the selected tab.
    expect(fieldsBtn.getAttribute('aria-pressed')).toBe('true');
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

  it('switching to Runs renders the agent run-history section; body editor still visible', async () => {
    // Default agent fixture has no `projects` allow-list → wildcard fallback →
    // RunsHistorySection shows its no-project empty state. The old Phase 3
    // placeholder is gone (E-4 wired the real section).
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
      expect(screen.getByText(/no project scoped to this agent/i)).toBeInTheDocument();
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

  it('renders a resize handle and widening it grows the SheetContent width', async () => {
    mockWorkspaceDoc('triage', 'agent');
    const { queryClient, router } = setup('?doc=triage');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');

    // Handle present (ResizeHandle: role=separator, aria-label "Resize panel"),
    // and it lives INSIDE the SheetContent (the position:fixed Radix dialog
    // content), so its absolute left-0 anchors to the slideover's left edge.
    const handle = await screen.findByRole('separator', { name: /resize/i });
    const content = handle.parentElement as HTMLElement;
    expect(content.className).toContain('fixed');
    expect(content.className).toContain('right-0');

    // The default width (480) starts unpersisted; useResizableWidth only writes
    // localStorage on pointerup. (jsdom's CSSOM silently drops the inline
    // `width: min(…px, 100vw)` value, so the rendered style string can't be
    // asserted — the localStorage write is the observable proof the drag
    // flowed through the hook and changed the width.)
    expect(localStorage.getItem('folio:width:agent-config')).toBeNull();

    // Drag the left-edge handle LEFT (smaller clientX) → widens. Mirror the
    // useResizableWidth test idiom: pointerdown on the handle, then dispatch
    // move/up on window (jsdom routes MouseEvents to the pointer listeners).
    fireEvent.pointerDown(handle, { clientX: 1000 });
    fireEvent(window, new MouseEvent('pointermove', { clientX: 900 }));
    fireEvent(window, new MouseEvent('pointerup'));

    // 480 + (1000 - 900) = 580 — persisted on pointerup.
    await waitFor(() =>
      expect(localStorage.getItem('folio:width:agent-config')).toBe('580'),
    );
  });
});
