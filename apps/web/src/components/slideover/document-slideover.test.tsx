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
import { DocumentSlideover } from './document-slideover.tsx';

function setup(initialSearch: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const project = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug',
    validateSearch: z.object({
      doc: z.string().optional(),
      status: z.union([z.string(), z.array(z.string())]).optional(),
      sort: z.string().optional(),
      dir: z.string().optional(),
    }),
    component: () => {
      const { wslug, pslug } = project.useParams();
      return (
        <>
          <div>project body</div>
          <DocumentSlideover wslug={wslug} pslug={pslug} />
        </>
      );
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([project]),
    history: createMemoryHistory({ initialEntries: [`/w/main/p/web${initialSearch}`] }),
  });
  return { queryClient, router };
}

function mockDoc(slug: string, type: 'work_item' | 'page' = 'work_item') {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (url) => {
      // Backlinks lives at /documents/:slug/backlinks — match it BEFORE the
      // broad /documents/:slug doc-detail branch so the doc envelope doesn't
      // leak into the backlinks query (server returns a row array here).
      if (String(url).includes('/backlinks')) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url).includes(`/documents/${slug}`)) {
        return new Response(
          JSON.stringify({
            data: {
              id: 'd1',
              slug,
              type,
              title: 'Fix login bug',
              status: 'todo',
              parentId: null,
              frontmatter: {},
              body: '# Steps\n\n1. Reproduce',
              createdAt: '2026-01-01',
              updatedAt: '2026-01-02',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (String(url).includes('/statuses')) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url).includes('/fields')) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

describe('DocumentSlideover', () => {
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
    await waitFor(() => expect(screen.getByText('project body')).toBeInTheDocument());
    expect(screen.queryByText('Fix login bug')).not.toBeInTheDocument();
  });

  it('opens and fetches when ?doc= is set', async () => {
    mockDoc('fix-login');
    const { queryClient, router } = setup('?doc=fix-login');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('Fix login bug')).toBeInTheDocument());
    expect(screen.getByText(/Reproduce/)).toBeInTheDocument();
  });

  it('clicking close removes ?doc= from the URL', async () => {
    mockDoc('fix-login');
    const { queryClient, router } = setup('?doc=fix-login');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Fix login bug');
    await userEvent.click(screen.getByRole('button', { name: /Close document/ }));
    await waitFor(() => expect(router.state.location.search).toEqual({}));
  });

  it('body editor fills available space; ActivityPanel sits in its own bounded container', async () => {
    // Before T3.29 the editor was wedged into a fixed 200px min-h inside the
    // outer scroll container, sharing space with ActivityPanel. The fix:
    // editor wrapper gets flex-1 (fills); activity panel has its own bounded
    // scroll box at the bottom.
    mockDoc('fix-login');
    const { queryClient, router } = setup('?doc=fix-login');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Fix login bug');

    const article = document.querySelector('article');
    expect(article).not.toBeNull();
    // The article is the flex column. Its FIRST non-header child (editor) must
    // claim flex-1 — that's the regression we're protecting. Identify by the
    // BodyEditor anchor (`data-testid` or distinctive content). Body editor
    // renders Milkdown which writes a contenteditable; check the wrapper has
    // flex-1 and min-h-0 (allow flex shrinking).
    const editorWrapper = article!.querySelector('[data-testid="slideover-editor"]');
    expect(editorWrapper).not.toBeNull();
    expect(editorWrapper!.className).toMatch(/flex-1/);
    expect(editorWrapper!.className).toMatch(/min-h-0/);

    // ActivityPanel is bounded — its wrapper has `shrink-0` so it doesn't
    // expand to crowd the editor. (max-h + overflow-y-auto are the impl;
    // shrink-0 is the cheapest stable class to assert against.)
    const activityWrapper = article!.querySelector('[data-testid="slideover-activity"]');
    expect(activityWrapper).not.toBeNull();
    expect(activityWrapper!.className).toMatch(/shrink-0/);
  });

  it('for a wiki page (type=page), drops the FrontmatterForm and slug pill — the body editor goes top of the body area', async () => {
    // Stefan's rule: "a wiki is .md file without frontmatter." Work items
    // keep the full frontmatter form; pages render title + body only.
    mockDoc('intro', 'page');
    const { queryClient, router } = setup('?doc=intro');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Fix login bug'); // title still in SheetHeader

    const article = document.querySelector('article');
    expect(article).not.toBeNull();
    // The article's <header> is what carries the slug pill + frontmatter
    // form; when the doc is a page, that whole header is absent.
    expect(article!.querySelector('header')).toBeNull();
    // Editor wrapper still present.
    expect(article!.querySelector('[data-testid="slideover-editor"]')).not.toBeNull();
  });

  it('wiki pages render the formatting toolbar above the body editor', async () => {
    // 6 toolbar buttons + the Aa text-style trigger = 7 affordances total.
    // Work items DO NOT render this toolbar — its slideover already carries
    // the frontmatter form as the primary affordance.
    mockDoc('intro', 'page');
    const { queryClient, router } = setup('?doc=intro');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Fix login bug');

    expect(screen.getByRole('button', { name: /Text style/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Bullet list/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Numbered list/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Quote$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Code block/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Insert table/ })).toBeInTheDocument();
  });

  it('work items DO NOT render the formatting toolbar', async () => {
    mockDoc('fix-login', 'work_item');
    const { queryClient, router } = setup('?doc=fix-login');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Fix login bug');

    expect(screen.queryByRole('button', { name: /Text style/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Bullet list/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Insert table/ })).toBeNull();
  });

  it('renders the toolbar with Copy MD + Edit/Raw toggle + Activity + ⋯ + Close when a doc is open', async () => {
    mockDoc('fix-login');
    const { queryClient, router } = setup('?doc=fix-login');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Fix login bug');

    const toolbar = screen.getByTestId('slideover-toolbar');
    expect(toolbar).toBeInTheDocument();
    // Copy MD button (Button variant secondary).
    expect(toolbar.textContent).toContain('Copy MD');
    // ModeToggle exposes two pressable buttons.
    const edit = toolbar.querySelector('button[aria-pressed="true"]');
    expect(edit).not.toBeNull();
    expect(edit!.textContent).toContain('Edit');
    // LogActivityButton has its dedicated aria-label.
    expect(toolbar.querySelector('button[aria-label="Log activity"]')).not.toBeNull();
    // The ⋯ trigger and the Close icon button both sit in the toolbar.
    expect(screen.getByTestId('slideover-more-actions')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Close document/ })).toBeInTheDocument();

    // The body header no longer carries the LogActivityButton or ModeToggle —
    // both moved up to the slideover header. The slug pill stays.
    const article = document.querySelector('article');
    expect(article).not.toBeNull();
    const articleHeader = article!.querySelector('header');
    expect(articleHeader).not.toBeNull();
    expect(articleHeader!.querySelector('button[aria-label="Log activity"]')).toBeNull();
    // ModeToggle's "Edit" button is no longer in the article header.
    expect(articleHeader!.textContent).not.toContain('Edit');
    expect(articleHeader!.textContent).toContain('/fix-login');
  });

  it('clicking ⋯ → Delete opens the confirm dialog; Cancel closes it without deleting', async () => {
    mockDoc('fix-login');
    const { queryClient, router } = setup('?doc=fix-login');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Fix login bug');

    await userEvent.click(screen.getByTestId('slideover-more-actions'));
    const deleteItem = await screen.findByRole('menuitem', { name: /Delete/ });
    await userEvent.click(deleteItem);

    // Dialog body confirms intent and quotes the title. The slideover title
    // also renders "Fix login bug", so we scope the title-quote check to the
    // dialog body text instead of querying by text alone.
    const dialogTitle = await screen.findByText(/Delete this document\?/);
    expect(dialogTitle).toBeInTheDocument();
    // Dialog body description sits in the same Radix dialog content node.
    const dialogContent = dialogTitle.parentElement;
    expect(dialogContent).not.toBeNull();
    expect(dialogContent!.textContent).toContain('Fix login bug');

    // Cancel closes the dialog and leaves the slideover open. No DELETE fired.
    await userEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    await waitFor(() => {
      expect(screen.queryByText(/Delete this document\?/)).not.toBeInTheDocument();
    });
    // Slideover still mounted.
    expect(screen.getByText('Fix login bug')).toBeInTheDocument();
  });

  it('confirming the delete dialog fires DELETE and closes the slideover', async () => {
    const deleteCalls: Array<{ url: string; method: string }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (method === 'DELETE') {
        deleteCalls.push({ url: u, method });
        return new Response(null, { status: 204 });
      }
      if (u.includes('/documents/fix-login')) {
        return new Response(
          JSON.stringify({
            data: {
              id: 'd1',
              slug: 'fix-login',
              type: 'work_item',
              title: 'Fix login bug',
              status: 'todo',
              parentId: null,
              frontmatter: {},
              body: '# Steps\n\n1. Reproduce',
              createdAt: '2026-01-01',
              updatedAt: '2026-01-02',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // Any other list endpoint (statuses, fields, settings/ai-keys,
      // workspaces, documents list) → empty array. Returning `{}` here
      // would make useFields/useStatuses resolve to `{}` instead of `[]`,
      // and downstream `.map()` calls would explode.
      if (
        u.includes('/statuses') ||
        u.includes('/fields') ||
        u.includes('/settings/ai-keys') ||
        u.includes('/workspaces') ||
        u.includes('/documents')
      ) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = setup('?doc=fix-login');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Fix login bug');

    await userEvent.click(screen.getByTestId('slideover-more-actions'));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Delete/ }));
    // Two "Delete" buttons exist at this point: the menu item (now closed) and
    // the danger button in the dialog. The visible one is the dialog action.
    const dialogDelete = await screen.findByRole('button', { name: /^Delete$/ });
    await userEvent.click(dialogDelete);

    await waitFor(() => {
      expect(deleteCalls.length).toBe(1);
      expect(deleteCalls[0].url).toContain('/documents/fix-login');
    });
    // ?doc= is cleared after a successful delete, closing the slideover.
    await waitFor(() => {
      const s = router.state.location.search as Record<string, unknown>;
      expect(s.doc).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------
  // Header tabs (NocoDB-style icon toggles in the single header row)
  // ---------------------------------------------------------------------

  function mockDocWithComments(
    slug: string,
    type: 'work_item' | 'page',
    commentCount: number,
  ) {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (url) => {
        const u = String(url);
        if (u.includes(`/documents/${slug}/comments`)) {
          const comments = Array.from({ length: commentCount }, (_, i) => ({
            id: `c-${i}`,
            slug: `comment-c-${i}`,
            type: 'comment',
            title: '',
            parentId: 'd1',
            projectId: 'proj-1',
            workspaceId: 'ws-1',
            body: `comment ${i}`,
            frontmatter: { author: 'user:u-1', kind: 'comment', visibility: 'normal', mentions: [] },
            createdAt: '2026-05-26T10:00:00.000Z',
            updatedAt: '2026-05-26T10:00:00.000Z',
          }));
          return new Response(JSON.stringify({ data: comments }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        if (u.endsWith(`/documents/${slug}`) || u.includes(`/documents/${slug}?`)) {
          return new Response(
            JSON.stringify({
              data: {
                id: 'd1',
                slug,
                type,
                title: 'Fix login bug',
                status: 'todo',
                parentId: null,
                frontmatter: {},
                body: '# Steps\n\n1. Reproduce',
                createdAt: '2026-01-01',
                updatedAt: '2026-01-02',
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (u.includes('/members')) {
          return new Response(JSON.stringify({ data: { members: [] } }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        if (u.includes('/auth/me')) {
          return new Response(JSON.stringify({ data: { user: { id: 'u-1', email: 'a@b', name: 'A' } } }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        if (u.includes('/statuses') || u.includes('/fields') || u.includes('/settings/ai-keys')) {
          return new Response(JSON.stringify({ data: [] }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        if (u.match(/\/w\/[^/]+\/p\/[^/?]+($|\?)/)) {
          // useProject endpoint
          return new Response(
            JSON.stringify({ data: { id: 'proj-1', workspaceId: 'ws-1', slug: 'web', name: 'Web', icon: null, description: null, archivedAt: null, createdAt: '', updatedAt: '' } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (u.match(/\/w\/[^/?]+($|\?)/)) {
          // useWorkspace endpoint
          return new Response(
            JSON.stringify({ data: { id: 'ws-1', slug: 'main', name: 'Main' } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        // G1: workspace documents listing — used by CommentsTab's
        // useWorkspaceAgents to resolve id-canonical authors. Returns the
        // FLAT { data: [] } shape useWorkspaceDocuments expects.
        if (u.match(/\/w\/[^/]+\/documents(\?|$)/)) {
          return new Response(JSON.stringify({ data: [] }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        if (u.includes('/documents')) {
          return new Response(JSON.stringify({ data: { data: [], nextCursor: null } }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
  }

  it('renders the icon tab toggles Fields / Comments / Activity for a work_item', async () => {
    mockDocWithComments('fix-login', 'work_item', 0);
    const { queryClient, router } = setup('?doc=fix-login');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Fix login bug');

    // Icon-only tabs: the accessible name lives on aria-label, not text.
    expect(screen.getByRole('tab', { name: 'Fields' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Comments' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Activity' })).toBeInTheDocument();
  });

  it('renders the icon tab toggles Fields / Comments / Activity for a page', async () => {
    mockDocWithComments('intro', 'page', 0);
    const { queryClient, router } = setup('?doc=intro');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Fix login bug');

    expect(screen.getByRole('tab', { name: 'Fields' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Comments' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Activity' })).toBeInTheDocument();
  });

  it('defaults to the Fields tab on open (aria-selected)', async () => {
    mockDocWithComments('fix-login', 'work_item', 0);
    const { queryClient, router } = setup('?doc=fix-login');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Fix login bug');

    expect(screen.getByRole('tab', { name: 'Fields' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows the comment count as a badge on the Comments tab', async () => {
    // Regression: the count badge was dropped in the HeaderTabs refactor. With
    // 3 comments the Comments tab must show "3" (HeaderTabs renders count>0).
    mockDocWithComments('fix-login', 'work_item', 3);
    const { queryClient, router } = setup('?doc=fix-login');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Fix login bug');

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Comments' })).toHaveTextContent('3');
    });
  });

  it('switching to the Activity tab mounts the ActivityPanel and HIDES the body editor', async () => {
    mockDocWithComments('fix-login', 'work_item', 0);
    const { queryClient, router } = setup('?doc=fix-login');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Fix login bug');

    // On Fields (default) the body editor is present; ActivityPanel copy is not.
    expect(document.querySelector('[data-testid="slideover-editor"]')).not.toBeNull();
    expect(screen.queryByText(/No activity yet\./)).toBeNull();

    await userEvent.click(screen.getByRole('tab', { name: 'Activity' }));

    // ActivityPanel renders "No activity yet." for the empty-events case.
    await waitFor(() => {
      expect(screen.getByText(/No activity yet\./)).toBeInTheDocument();
    });

    // The Milkdown body editor only belongs on Fields — gone on Activity.
    expect(document.querySelector('[data-testid="slideover-editor"]')).toBeNull();
  });

  it('switching to the Comments tab mounts the CommentsTab and HIDES the body editor', async () => {
    mockDocWithComments('fix-login', 'work_item', 0);
    const { queryClient, router } = setup('?doc=fix-login');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Fix login bug');

    await userEvent.click(screen.getByRole('tab', { name: 'Comments' }));

    // CommentsTab renders a "0 comments · newest first" row when empty.
    await waitFor(() => {
      expect(screen.getByText(/comments · newest first/)).toBeInTheDocument();
    });
    // Body editor is NOT rendered on the Comments tab.
    expect(document.querySelector('[data-testid="slideover-editor"]')).toBeNull();
  });

  it('reopening with a different doc resets the tab back to Fields', async () => {
    // Two different docs the same fetch mock can serve, keyed off the URL.
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (url) => {
        const u = String(url);
        const m = u.match(/\/documents\/(fix-login|other-doc)(\?|$)/);
        if (m) {
          const slug = m[1];
          return new Response(
            JSON.stringify({
              data: {
                id: slug === 'fix-login' ? 'd1' : 'd2',
                slug,
                type: 'work_item',
                title: slug === 'fix-login' ? 'Fix login bug' : 'Other doc',
                status: 'todo',
                parentId: null,
                frontmatter: {},
                body: '# Body',
                createdAt: '2026-01-01',
                updatedAt: '2026-01-02',
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (u.includes('/comments')) {
          return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (u.includes('/auth/me')) {
          return new Response(JSON.stringify({ data: { user: { id: 'u-1', email: 'a@b', name: 'A' } } }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        if (u.includes('/statuses') || u.includes('/fields') || u.includes('/settings/ai-keys') || u.includes('/members')) {
          return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (u.match(/\/w\/[^/]+\/p\/[^/?]+($|\?)/)) {
          return new Response(JSON.stringify({ data: { id: 'proj-1', workspaceId: 'ws-1', slug: 'web', name: 'Web', icon: null, description: null, archivedAt: null, createdAt: '', updatedAt: '' } }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        if (u.match(/\/w\/[^/?]+($|\?)/)) {
          return new Response(JSON.stringify({ data: { id: 'ws-1', slug: 'main', name: 'Main' } }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        if (u.includes('/documents')) {
          return new Response(JSON.stringify({ data: { data: [], nextCursor: null } }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );

    const { queryClient, router } = setup('?doc=fix-login');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Fix login bug');

    // Switch to Activity.
    await userEvent.click(screen.getByRole('tab', { name: 'Activity' }));
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true');
    });

    // Navigate to a different doc without closing the sheet.
    await router.navigate({ to: '.', search: { doc: 'other-doc' } });
    await screen.findByText('Other doc');

    // Tab has reset to Fields.
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Fields' })).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('the body editor is present ONLY on the Fields tab', async () => {
    mockDocWithComments('fix-login', 'work_item', 0);
    const { queryClient, router } = setup('?doc=fix-login');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Fix login bug');

    // Fields (default): editor present.
    expect(document.querySelector('[data-testid="slideover-editor"]')).not.toBeNull();

    // Comments: editor gone.
    await userEvent.click(screen.getByRole('tab', { name: 'Comments' }));
    await waitFor(() => {
      expect(document.querySelector('[data-testid="slideover-editor"]')).toBeNull();
    });

    // Back to Fields: editor returns.
    await userEvent.click(screen.getByRole('tab', { name: 'Fields' }));
    await waitFor(() => {
      expect(document.querySelector('[data-testid="slideover-editor"]')).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // Buffered save (header disk icon) — unified-document-save
  // ---------------------------------------------------------------------

  // A self-contained mock for the buffered-save tests: serves the doc detail
  // (capturing PATCH bodies), one status option, and empty arrays for the rest.
  function mockSaveDoc(
    slug: string,
    type: 'work_item' | 'page',
    opts: { onPatch?: (body: unknown) => void; statuses?: boolean } = {},
  ) {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (url, init) => {
        const u = String(url);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (u.includes('/backlinks')) {
          return new Response(JSON.stringify({ data: [] }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        if (u.includes(`/documents/${slug}`) && !u.includes('/documents/' + slug + '/comments')) {
          if (method === 'PATCH' && opts.onPatch) {
            try {
              opts.onPatch(init?.body ? JSON.parse(String(init.body)) : null);
            } catch {
              opts.onPatch(init?.body);
            }
          }
          return new Response(
            JSON.stringify({
              data: {
                id: 'd1',
                slug,
                type,
                title: 'Fix login bug',
                status: 'todo',
                parentId: null,
                frontmatter: {},
                body: '# Steps\n\n1. Reproduce',
                createdAt: '2026-01-01',
                updatedAt: '2026-01-02',
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (u.includes('/statuses')) {
          return new Response(
            JSON.stringify({
              data: opts.statuses
                ? [
                    { key: 'todo', name: 'Todo', color: '#888', order: 0 },
                    { key: 'in_progress', name: 'In progress', color: '#08f', order: 1 },
                  ]
                : [],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (u.includes('/fields') || u.includes('/settings/ai-keys') || u.includes('/workspaces')) {
          return new Response(JSON.stringify({ data: [] }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        if (u.includes('/documents')) {
          return new Response(JSON.stringify({ data: { data: [], nextCursor: null } }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
  }

  it('shows a disabled Save icon when clean, enables after a body edit, and PATCHes on save', async () => {
    const patches: unknown[] = [];
    mockSaveDoc('fix-login', 'work_item', { onPatch: (p) => patches.push(p) });
    const { queryClient, router } = setup('?doc=fix-login');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Fix login bug');
    const saveBtn = screen.getByRole('button', { name: 'Save' });
    expect(saveBtn).toBeDisabled();

    // Switch to raw markdown via the header ModeToggle (it's in the header on the
    // Fields tab, not in a menu). The Raw button toggles the editor to a textarea.
    await userEvent.click(screen.getByRole('button', { name: /Raw/ }));
    const textarea = await screen.findByRole('textbox');
    await userEvent.type(textarea, ' edited');
    await waitFor(() => expect(saveBtn).toBeEnabled());

    await userEvent.click(saveBtn);
    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    expect(patches[0]).toMatchObject({ body: expect.stringContaining('edited') });
  });

  it('status commit still PATCHes immediately and does NOT make the buffer dirty', async () => {
    const patches: Array<Record<string, unknown>> = [];
    mockSaveDoc('fix-login', 'work_item', {
      statuses: true,
      onPatch: (p) => patches.push(p as Record<string, unknown>),
    });
    const { queryClient, router } = setup('?doc=fix-login');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Fix login bug');
    const saveBtn = screen.getByRole('button', { name: 'Save' });
    expect(saveBtn).toBeDisabled();

    // Open the status InlineSelect (its trigger renders the current "Todo" chip)
    // and pick "In progress".
    await userEvent.click(screen.getByRole('button', { name: /Todo/ }));
    await userEvent.click(await screen.findByRole('option', { name: /In progress/ }));

    await waitFor(() => expect(patches.some((p) => p.status === 'in_progress')).toBe(true));
    // Status is immediate-commit, not buffered: the Save icon stays disabled.
    expect(saveBtn).toBeDisabled();
  });

  it('closing while dirty prompts; Save persists then closes', async () => {
    const patches: unknown[] = [];
    mockSaveDoc('fix-login', 'work_item', { onPatch: (p) => patches.push(p) });
    const { queryClient, router } = setup('?doc=fix-login');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Fix login bug');
    await userEvent.click(screen.getByRole('button', { name: /Raw/ }));
    const textarea = await screen.findByRole('textbox');
    await userEvent.type(textarea, ' edited');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());

    await userEvent.click(screen.getByRole('button', { name: /Close document/ }));
    expect(await screen.findByText(/Unsaved changes/i)).toBeInTheDocument();

    // The dialog's primary Save button persists then proceeds (closes).
    const dialogSave = screen.getAllByRole('button', { name: /^Save$/ }).find(
      (b) => b.getAttribute('aria-label') !== 'Save',
    );
    expect(dialogSave).toBeDefined();
    await userEvent.click(dialogSave!);
    await waitFor(() => expect(patches.length).toBeGreaterThan(0));
    expect(patches[0]).toMatchObject({ body: expect.stringContaining('edited') });
    await waitFor(() => expect(screen.queryByText('Fix login bug')).not.toBeInTheDocument());
  });

  it('switching to a different doc while dirty opens the unsaved prompt; Discard lands on the new doc', async () => {
    // Two real docs: the dirty one (fix-login) and the switch target (other-doc).
    // Both must return a valid frontmatter object so the brief render of the
    // target during the URL revert doesn't crash FrontmatterForm.
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (url) => {
        const u = String(url);
        if (u.includes('/backlinks')) {
          return new Response(JSON.stringify({ data: [] }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        const m = u.match(/\/documents\/(fix-login|other-doc)(\?|$)/);
        if (m) {
          const slug = m[1];
          return new Response(
            JSON.stringify({
              data: {
                id: slug === 'fix-login' ? 'd1' : 'd2',
                slug,
                type: 'work_item',
                title: slug === 'fix-login' ? 'Fix login bug' : 'Other doc',
                status: 'todo',
                parentId: null,
                frontmatter: {},
                body: '# Body',
                createdAt: '2026-01-01',
                updatedAt: '2026-01-02',
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (u.includes('/statuses') || u.includes('/fields') || u.includes('/settings/ai-keys')) {
          return new Response(JSON.stringify({ data: [] }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        if (u.includes('/documents')) {
          return new Response(JSON.stringify({ data: { data: [], nextCursor: null } }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    const { queryClient, router } = setup('?doc=fix-login');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Fix login bug');
    await userEvent.click(screen.getByRole('button', { name: /Raw/ }));
    const textarea = await screen.findByRole('textbox');
    await userEvent.type(textarea, ' edited');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());

    // Programmatic switch to a different doc (simulates clicking another row).
    await router.navigate({ to: '.', search: { doc: 'other-doc' } });

    // The switch is intercepted: the prompt appears and the URL is reverted to
    // the still-loaded doc so it isn't swapped out from under the dirty buffer.
    expect(await screen.findByText(/Unsaved changes/i)).toBeInTheDocument();
    await waitFor(() =>
      expect((router.state.location.search as { doc?: string }).doc).toBe('fix-login'),
    );

    // Discard resets the buffer (isDirty → false), proceed() re-applies the
    // intended switch, and the effect lets it through cleanly → land on the new doc.
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() =>
      expect((router.state.location.search as { doc?: string }).doc).toBe('other-doc'),
    );
  });

  it('derives listParams from URL search so optimistic writes target the active table cache', async () => {
    // URL carries status=todo and sort=title desc — the slideover's internal
    // documents.list fetch (used for optimistic updates) must mirror those
    // filters, not the hardcoded { type:'work_item', sort:'updated_at', dir:'desc' }.
    const fetchedUrls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      fetchedUrls.push(u);
      if (u.includes('/documents/fix-login')) {
        return new Response(
          JSON.stringify({
            data: {
              id: 'd1',
              slug: 'fix-login',
              type: 'work_item',
              title: 'Fix login bug',
              status: 'todo',
              parentId: null,
              frontmatter: {},
              body: '# Steps\n\n1. Reproduce',
              createdAt: '2026-01-01',
              updatedAt: '2026-01-02',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/statuses') || u.includes('/fields') || u.includes('/settings/ai-keys') || u.includes('/workspaces')) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/documents')) {
        return new Response(
          JSON.stringify({ data: { data: [], nextCursor: null } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = setup('?doc=fix-login&status=todo&sort=title&dir=desc');
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByText('Fix login bug');

    // The internal documents-list fetch must reflect URL state.
    await waitFor(() => {
      const listRequests = fetchedUrls.filter(
        (u) => u.includes('/documents?') && !u.includes('/documents/fix-login'),
      );
      expect(
        listRequests.some(
          (u) => u.includes('status=todo') && u.includes('sort=title') && u.includes('dir=desc'),
        ),
      ).toBe(true);
    });
  });
});
