import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
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
import { AgentList } from './agent-list.tsx';

function setup(initialSearch = '') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const workspace = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug',
    validateSearch: z.object({ wdoc: z.string().optional() }),
    component: () => {
      const { wslug } = workspace.useParams();
      return <AgentList wslug={wslug} />;
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([workspace]),
    history: createMemoryHistory({ initialEntries: [`/w/main${initialSearch}`] }),
  });
  return { queryClient, router };
}

/** Stub fetch: list returns the given agents; POST returns a created agent. */
function stubFetch(
  agents: Array<{ slug: string; title: string }>,
  createdSlug = 'untitled-1',
) {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'POST' && u.includes('/w/main/documents')) {
        return new Response(
          JSON.stringify({
            data: {
              id: 'new',
              slug: createdSlug,
              type: 'agent',
              title: 'Untitled',
              status: null,
              parentId: null,
              frontmatter: {},
              body: '',
              createdAt: '',
              updatedAt: '',
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/w/main/documents')) {
        return new Response(
          JSON.stringify({
            data: agents.map((a, i) => ({
              id: `a${i}`,
              slug: a.slug,
              type: 'agent',
              title: a.title,
              status: null,
              parentId: null,
              frontmatter: {},
              createdAt: '',
              updatedAt: '',
              lastTouchedAt: null,
            })),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

function renderList(initialSearch = '') {
  const { queryClient, router } = setup(initialSearch);
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('AgentList', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders both agent titles and a New agent button', async () => {
    stubFetch([
      { slug: 'triage', title: 'Triage Agent' },
      { slug: 'reply', title: 'Reply Bot' },
    ]);
    renderList();
    await screen.findByText('Triage Agent');
    expect(screen.getByText('Reply Bot')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new agent/i })).toBeInTheDocument();
  });

  it('clicking an agent row sets ?wdoc=<slug> on the current route', async () => {
    stubFetch([
      { slug: 'triage', title: 'Triage Agent' },
      { slug: 'reply', title: 'Reply Bot' },
    ]);
    const router = renderList();
    const row = await screen.findByText('Reply Bot');
    await userEvent.click(row);
    await waitFor(() => {
      expect((router.state.location.search as { wdoc?: string }).wdoc).toBe('reply');
    });
  });

  it('shows an empty state with the New agent button when there are no agents', async () => {
    stubFetch([]);
    renderList();
    await screen.findByText(/no agents yet/i);
    expect(screen.getByRole('button', { name: /new agent/i })).toBeInTheDocument();
  });

  it('New agent creates an agent then sets ?wdoc=<created.slug>', async () => {
    stubFetch([], 'untitled-1');
    const router = renderList();
    const btn = await screen.findByRole('button', { name: /new agent/i });
    await userEvent.click(btn);
    await waitFor(() => {
      expect((router.state.location.search as { wdoc?: string }).wdoc).toBe('untitled-1');
    });
  });
});
