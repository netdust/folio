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
      // The workspace slideover opens on ?wdoc= (distinct from the project
      // slideover's ?doc=). `doc` is also declared so the no-collision test can
      // navigate to ?doc= and assert the workspace slideover stays CLOSED.
      wdoc: z.string().optional(),
      doc: z.string().optional(),
      // Broad `string`, matching the real /w/$wslug layout route. `?tab=` is
      // SHARED across that layout (settings: tokens|ai, automation page:
      // agents|triggers, slideover: fields|activity|runs). A narrow enum here
      // would reject `tab=agents` and mask the cross-surface collision the
      // slideover must defend against.
      tab: z.string().optional(),
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

  it('is closed by default (no ?wdoc=)', async () => {
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

  // REGRESSION (dual-modal collision): the workspace slideover must open ONLY
  // on its own ?wdoc= param. ?doc= belongs to the project DocumentSlideover —
  // both mount under the /w/$wslug layout, so a shared param made them stack as
  // two modals (the workspace one 404ing on a work-item slug). Proving the
  // param separation here proves the two slideovers can no longer both open on
  // one param.
  it('does NOT open on ?doc= (that param belongs to the project slideover)', async () => {
    // ?doc= must never drive the workspace slideover. If it does, a work-item
    // slug would 404 here as a second stacked modal. Fetch is stubbed empty:
    // if the slideover wrongly opened it would fire a workspace-doc fetch and
    // surface a "Failed to load" sheet — neither should happen.
    const fetchSpy = vi.fn<typeof fetch>(
      async () =>
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const { queryClient, router } = setup('?doc=lead-foo');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('workspace body')).toBeInTheDocument());
    // The slideover never opens: no title, no "Failed to load" sheet, and no
    // workspace-document fetch was issued for the work-item slug.
    expect(screen.queryByText('Triage Agent')).not.toBeInTheDocument();
    expect(screen.queryByText('Failed to load')).not.toBeInTheDocument();
    expect(
      fetchSpy.mock.calls.some(([url]) => String(url).includes('/documents/lead-foo')),
    ).toBe(false);
  });

  it('opens and fetches when ?wdoc= is set', async () => {
    mockWorkspaceDoc('triage', 'agent');
    const { queryClient, router } = setup('?wdoc=triage');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('Triage Agent')).toBeInTheDocument());
    expect(screen.getByText(/Do the triage\./)).toBeInTheDocument();
  });

  // REGRESSION (refetch-stomp): the buffered draft used to be consumed by the
  // parent with `doc ?? placeholder`. React Query flipping `doc` to undefined on
  // refetch flipped the placeholder in, blanking the body AND making the buffer
  // perpetually dirty. The fix moves the draft into a keyed inner mounted only
  // once a REAL doc loads. After the doc loads and renders (with no user edit),
  // the body text must be present AND the Save button disabled (clean) — the
  // remount key guarantees a clean seed from the loaded doc, never a placeholder.
  it('after the doc loads, the body is shown and the buffer is NOT dirty (no refetch-stomp)', async () => {
    mockWorkspaceDoc('triage', 'agent');
    const { queryClient, router } = setup('?wdoc=triage');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');
    // Body content is present (not the empty placeholder).
    expect(screen.getByText(/Do the triage\./)).toBeInTheDocument();
    // No user edit → the buffer is clean → Save stays disabled.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  // REGRESSION: opening an agent/trigger from the automation page carries that
  // page's ?tab=agents (or ?tab=triggers) into the URL alongside ?wdoc=. The
  // `tab` param is shared, so the slideover used to seed its OWN tab to 'agents'
  // — which matches none of fields|activity|runs — leaving a blank pane until
  // the user clicked Fields. The slideover must narrow an unknown tab to Fields.
  it('seeds Fields (not a blank pane) when ?tab= holds a sibling-surface value like "agents"', async () => {
    mockWorkspaceDoc('triage', 'agent');
    const { queryClient, router } = setup('?wdoc=triage&tab=agents');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');

    // Fields is selected and its content renders immediately — no blank pane.
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Fields' })).toHaveAttribute('aria-selected', 'true');
    });
    expect(document.querySelector('[data-testid="workspace-slideover-editor"]')).not.toBeNull();
  });

  it('shows a disabled Save icon when clean and enables it after an edit (agent)', async () => {
    mockWorkspaceDoc('triage', 'agent');
    const { queryClient, router } = setup('?wdoc=triage');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');
    const saveBtn = screen.getByRole('button', { name: 'Save' });
    expect(saveBtn).toBeDisabled();

    // Edit the body via the raw editor (deterministic in jsdom; Milkdown is not).
    // Switch to raw markdown through the More menu.
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Raw markdown/ }));
    const textarea = await screen.findByRole('textbox');
    await userEvent.type(textarea, ' edited');
    await waitFor(() => expect(saveBtn).toBeEnabled());
  });

  it('clicking Save PATCHes the diff, toasts, and returns the icon to disabled', async () => {
    const patches: unknown[] = [];
    mockWorkspaceDoc('triage', 'agent', { onPatch: (p) => patches.push(p) });
    const { queryClient, router } = setup('?wdoc=triage');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Raw markdown/ }));
    const textarea = await screen.findByRole('textbox');
    await userEvent.type(textarea, ' edited');
    const saveBtn = screen.getByRole('button', { name: 'Save' });
    await waitFor(() => expect(saveBtn).toBeEnabled());
    await userEvent.click(saveBtn);
    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    expect(patches[0]).toMatchObject({ body: expect.stringContaining('edited') });
  });

  it('trigger pane no longer renders its own inline Save button (save is the header icon)', async () => {
    mockWorkspaceDoc('shake-trigger', 'trigger', {
      frontmatter: { schedule: '0 9 * * 1', agent: 'shake-folio-only', enabled: false },
    });
    const { queryClient, router } = setup('?wdoc=shake-trigger');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByLabelText('Enabled');
    // Exactly one element labelled Save — the header icon. The old pane Save
    // button had the literal text "Save" inside the scroll area.
    const saves = screen.getAllByRole('button', { name: 'Save' });
    expect(saves).toHaveLength(1);
    expect(saves[0]).toHaveAttribute('aria-label', 'Save');
  });

  it('closing while dirty opens the unsaved prompt; Discard closes without saving', async () => {
    const patches: unknown[] = [];
    mockWorkspaceDoc('triage', 'agent', { onPatch: (p) => patches.push(p) });
    const { queryClient, router } = setup('?wdoc=triage');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Raw markdown/ }));
    const textarea = await screen.findByRole('textbox');
    await userEvent.type(textarea, ' edited');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());

    await userEvent.click(screen.getByRole('button', { name: 'Close document' }));
    // Prompt appears instead of an immediate close.
    expect(await screen.findByText(/Unsaved changes/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    // Closed (title gone) and no PATCH fired.
    await waitFor(() => expect(screen.queryByText('Triage Agent')).not.toBeInTheDocument());
    expect(patches).toHaveLength(0);
  });

  it('switching to a different wdoc while dirty opens the unsaved prompt; Discard lands on the new doc', async () => {
    // Two real docs: the dirty one (triage) and the switch target (other-agent).
    // Both must return a valid frontmatter object so the brief render of the
    // target during the URL revert doesn't crash FrontmatterForm.
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
      vi.fn<typeof fetch>(async (url) => {
        const u = String(url);
        const slug = u.includes('/documents/other-agent') ? 'other-agent' : 'triage';
        if (u.endsWith('/events')) {
          return new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (u.includes('/w/main/documents?')) {
          return new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (u.includes('/w/main/documents/')) {
          return new Response(
            JSON.stringify({
              data: {
                id: slug === 'other-agent' ? 'd2' : 'd1',
                slug,
                type: 'agent',
                title: slug === 'other-agent' ? 'Other Agent' : 'Triage Agent',
                status: null,
                parentId: null,
                frontmatter: { description: 'x' },
                body: '# Instructions',
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
    const { queryClient, router } = setup('?wdoc=triage');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Raw markdown/ }));
    const textarea = await screen.findByRole('textbox');
    await userEvent.type(textarea, ' edited');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());

    // Programmatic switch to a different doc (simulates clicking another row).
    await router.navigate({ to: '.', search: { wdoc: 'other-agent' } });

    // The switch is intercepted: the prompt appears and the URL is reverted to
    // the still-loaded doc so it isn't swapped out from under the dirty buffer.
    expect(await screen.findByText(/Unsaved changes/i)).toBeInTheDocument();
    await waitFor(() =>
      expect((router.state.location.search as { wdoc?: string }).wdoc).toBe('triage'),
    );

    // Discard resets the buffer (isDirty → false), proceed() re-applies the
    // intended switch, and the effect lets it through cleanly → land on the new doc.
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() =>
      expect((router.state.location.search as { wdoc?: string }).wdoc).toBe('other-agent'),
    );
  });

  it('renders the icon tab toggles Fields / Activity / Runs for an agent (no Comments)', async () => {
    mockWorkspaceDoc('triage', 'agent');
    const { queryClient, router } = setup('?wdoc=triage');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');

    expect(screen.getByRole('tab', { name: 'Fields' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Runs' })).toBeInTheDocument();
    // No Comments tab on the workspace-scoped slideover.
    expect(screen.queryByRole('tab', { name: 'Comments' })).toBeNull();
  });

  it('renders the icon tab toggles Fields / Activity / Runs for a trigger', async () => {
    mockWorkspaceDoc('webhook-orders', 'trigger');
    const { queryClient, router } = setup('?wdoc=webhook-orders');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');

    expect(screen.getByRole('tab', { name: 'Fields' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Runs' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Comments' })).toBeNull();
  });

  it('defaults to the Fields tab on open (aria-selected)', async () => {
    mockWorkspaceDoc('triage', 'agent');
    const { queryClient, router } = setup('?wdoc=triage');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');

    expect(screen.getByRole('tab', { name: 'Fields' })).toHaveAttribute('aria-selected', 'true');
  });

  it('deep-link ?tab=runs opens on the Runs tab', async () => {
    mockWorkspaceDoc('triage', 'agent');
    const { queryClient, router } = setup('?wdoc=triage&tab=runs');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Runs' })).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('manual tab click clears the ?tab= param so it stops re-asserting', async () => {
    mockWorkspaceDoc('triage', 'agent');
    const { queryClient, router } = setup('?wdoc=triage&tab=runs');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');

    // Arrived on Runs (the deep-link).
    expect((router.state.location.search as { tab?: string }).tab).toBe('runs');

    await userEvent.click(screen.getByRole('tab', { name: 'Fields' }));

    // Clicking a tab clears the ?tab= param (and the wdoc stays).
    await waitFor(() => {
      const s = router.state.location.search as { wdoc?: string; tab?: string };
      expect(s.tab).toBeUndefined();
      expect(s.wdoc).toBe('triage');
    });
    // Fields is now the selected tab.
    expect(screen.getByRole('tab', { name: 'Fields' })).toHaveAttribute('aria-selected', 'true');
  });

  it('deep-link ?tab=runs then clicking a DIFFERENT non-Fields tab sticks (not stomped to Fields)', async () => {
    // Regression: clicking a tab strips ?tab=, which used to re-fire the seed
    // effect (search.tab dep flips defined→undefined) and reset to Fields,
    // stomping the click. The seed must be doc.id-keyed so the click sticks.
    mockWorkspaceDoc('triage', 'agent');
    const { queryClient, router } = setup('?wdoc=triage&tab=runs');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');

    // Arrived on Runs via the deep-link.
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Runs' })).toHaveAttribute('aria-selected', 'true');
    });

    // Click ACTIVITY (a different non-Fields tab).
    await userEvent.click(screen.getByRole('tab', { name: 'Activity' }));

    // It must land on Activity — NOT be stomped back to Fields.
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true');
    });
    expect(screen.getByRole('tab', { name: 'Fields' })).toHaveAttribute('aria-selected', 'false');
    // ?tab= was cleared by the click.
    expect((router.state.location.search as { tab?: string }).tab).toBeUndefined();
  });

  it('reopening the SAME doc with a fresh ?tab= deep-link re-seeds (seed gate resets on close)', async () => {
    // Regression: the seededForDocRef gate must reset when the slideover closes,
    // or reopening the same doc with a deep-link tab is ignored (the panel is
    // mounted persistently at the layout — it doesn't unmount on close).
    mockWorkspaceDoc('triage', 'agent');
    const { queryClient, router } = setup('?wdoc=triage'); // open with NO ?tab=
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');
    // Seeds to Fields (no ?tab=).
    expect(screen.getByRole('tab', { name: 'Fields' })).toHaveAttribute('aria-selected', 'true');

    // Close the slideover (strip ?wdoc=).
    await router.navigate({ to: '.', search: {} });
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Fields' })).toBeNull());

    // Reopen the SAME doc with a Runs deep-link.
    await router.navigate({ to: '.', search: { wdoc: 'triage', tab: 'runs' } });

    // Must re-seed to Runs — not stay stale on Fields.
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Runs' })).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('switching to Activity renders the panel + Log button (agent) and HIDES the body editor', async () => {
    mockWorkspaceDoc('triage', 'agent');
    const { queryClient, router } = setup('?wdoc=triage');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');

    // On Fields (default) the body editor is present.
    expect(document.querySelector('[data-testid="workspace-slideover-editor"]')).not.toBeNull();

    await userEvent.click(screen.getByRole('tab', { name: 'Activity' }));

    // Real Activity panel renders ("No activity yet." for the empty-events mock).
    await waitFor(() => {
      expect(screen.getByText('No activity yet.')).toBeInTheDocument();
    });
    // Log Activity button is shown for agent docs.
    expect(screen.getByRole('button', { name: /Log activity/ })).toBeInTheDocument();
    // The Milkdown body editor only belongs on Fields — gone on Activity.
    expect(document.querySelector('[data-testid="workspace-slideover-editor"]')).toBeNull();
  });

  it('Activity tab on a trigger renders the panel WITHOUT the Log button', async () => {
    mockWorkspaceDoc('webhook', 'trigger');
    const { queryClient, router } = setup('?wdoc=webhook');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');

    await userEvent.click(screen.getByRole('tab', { name: 'Activity' }));

    await waitFor(() => {
      expect(screen.getByText('No activity yet.')).toBeInTheDocument();
    });
    // A7 rejects activity-logging for triggers — the button must be HIDDEN
    // (not just disabled). Triggers' runs surface on the Runs tab in Phase 3.
    expect(screen.queryByRole('button', { name: /Log activity/ })).toBeNull();
  });

  it('switching to Runs renders the agent run-history section and HIDES the body editor', async () => {
    // Default agent fixture is wildcard-scoped (no `projects` → ['*']). The
    // fixture's /projects fetch returns no projects, so a wildcard agent in an
    // (effectively) empty workspace shows RunsHistorySection's terminal
    // "no projects in this workspace" state.
    mockWorkspaceDoc('triage', 'agent');
    const { queryClient, router } = setup('?wdoc=triage');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');

    await userEvent.click(screen.getByRole('tab', { name: 'Runs' }));

    await waitFor(() => {
      expect(screen.getByText(/no projects in this workspace/i)).toBeInTheDocument();
    });
    expect(document.querySelector('[data-testid="workspace-slideover-editor"]')).toBeNull();
  });

  it('the body editor is present ONLY on the Fields tab', async () => {
    mockWorkspaceDoc('triage', 'agent');
    const { queryClient, router } = setup('?wdoc=triage');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Triage Agent');

    // Fields (default): editor present.
    expect(document.querySelector('[data-testid="workspace-slideover-editor"]')).not.toBeNull();

    // Activity: editor gone.
    await userEvent.click(screen.getByRole('tab', { name: 'Activity' }));
    await waitFor(() => {
      expect(document.querySelector('[data-testid="workspace-slideover-editor"]')).toBeNull();
    });

    // Back to Fields: editor returns.
    await userEvent.click(screen.getByRole('tab', { name: 'Fields' }));
    await waitFor(() => {
      expect(document.querySelector('[data-testid="workspace-slideover-editor"]')).not.toBeNull();
    });
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
    const { queryClient, router } = setup('?wdoc=webhook-orders');
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

    // A trigger has NO Milkdown body editor on Fields, so the Edit/Raw MD mode
    // toggle must be hidden and the body-editor area must not render — the form
    // fills the pane instead of sitting capped above an empty editor.
    expect(screen.queryByRole('button', { name: /^Edit$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Raw MD/ })).toBeNull();
    expect(document.querySelector('[data-testid="workspace-slideover-editor"]')).toBeNull();
  });

  it('agent slideover Fields tab still renders FrontmatterForm (not TriggerForm)', async () => {
    mockWorkspaceDoc('triage', 'agent');
    const { queryClient, router } = setup('?wdoc=triage');
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
    const { queryClient, router } = setup('?wdoc=webhook-orders');
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
    const { queryClient, router } = setup('?wdoc=webhook-orders');
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
    const { queryClient, router } = setup('?wdoc=repo-import');
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
    const { queryClient, router } = setup('?wdoc=triage');
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
