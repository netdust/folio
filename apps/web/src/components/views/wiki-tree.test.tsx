import { describe, it, expect, afterEach, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { WikiTree } from './wiki-tree.tsx';

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const wiki = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/wiki',
    validateSearch: z.object({ doc: z.string().optional() }),
    component: () => {
      const { wslug, pslug } = wiki.useParams();
      return <WikiTree wslug={wslug} pslug={pslug} />;
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([wiki]),
    history: createMemoryHistory({ initialEntries: ['/w/main/p/web/wiki'] }),
  });
  return { queryClient, router };
}

function pagesResponse(items: Array<{ id: string; slug: string; title: string; parentId?: string | null }>) {
  return new Response(
    JSON.stringify({
      data: {
        data: items.map((i) => ({
          id: i.id, slug: i.slug, type: 'page', title: i.title,
          status: null, parentId: i.parentId ?? null,
          frontmatter: {}, createdAt: '', updatedAt: '',
        })),
        nextCursor: null,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function cardPagesResponse(
  items: Array<{ id: string; slug: string; title: string; parentId?: string | null; body?: string }>,
) {
  return new Response(
    JSON.stringify({
      data: {
        data: items.map((i) => ({
          id: i.id, slug: i.slug, type: 'page', title: i.title,
          status: null, parentId: i.parentId ?? null,
          frontmatter: {}, body: i.body ?? '',
          createdAt: '', updatedAt: '', lastTouchedAt: null,
        })),
        nextCursor: null,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('WikiTree', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders nested pages and toggles children visibility', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => pagesResponse([
      { id: 'a', slug: 'a', title: 'Parent' },
      { id: 'b', slug: 'b', title: 'Child', parentId: 'a' },
    ])));

    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText('Parent')).toBeInTheDocument());
    expect(screen.queryByText('Child')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Expand Parent/ }));
    expect(screen.getByText('Child')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Collapse Parent/ }));
    expect(screen.queryByText('Child')).not.toBeInTheDocument();
  });

  it('clicking a node sets ?doc=', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => pagesResponse([
      { id: 'a', slug: 'a', title: 'Parent' },
    ])));

    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    await userEvent.click(await screen.findByText('Parent'));
    await waitFor(() => expect(router.state.location.search).toEqual({ doc: 'a' }));
  });

  it('hover-reveal + on a row creates a child page with parentId set, then opens the slideover', async () => {
    // Capture the POST body so we can assert parentId was set to the row's
    // doc id. The hover-reveal `+` is the wiki's analogue of the rail's
    // hover `+`, and its job is to wire up the parent/child relationship
    // at create time.
    const createCalls: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/documents') && method === 'POST') {
        const body = init?.body instanceof ReadableStream
          ? await new Response(init.body).text()
          : String(init?.body ?? '{}');
        const parsed = JSON.parse(body);
        createCalls.push(parsed);
        return new Response(
          JSON.stringify({
            data: {
              id: 'child-new', slug: 'child-new', type: 'page',
              title: 'Untitled', status: null, parentId: parsed.parentId ?? null,
              frontmatter: {}, body: '', createdAt: '', updatedAt: '',
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      return pagesResponse([{ id: 'a', slug: 'a', title: 'Parent' }]);
    }));

    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText('Parent')).toBeInTheDocument());

    // Root pages render as cards; the card's add-child button carries an
    // aria-label rather than the TreeRow's wiki-add-child-{slug} testid.
    const addBtn = await screen.findByRole('button', { name: /Add child page under Parent/ });
    await userEvent.click(addBtn);

    await waitFor(() => expect(createCalls.length).toBe(1));
    expect(createCalls[0]).toEqual({ type: 'page', title: 'Untitled', parentId: 'a' });
    await waitFor(() => expect(router.state.location.search).toEqual({ doc: 'child-new' }));
  });

  it('empty state offers New page', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.includes('/documents') && method === 'POST') {
        return new Response(
          JSON.stringify({
            data: { id: 'new', slug: 'untitled', type: 'page', title: 'Untitled', status: null, parentId: null, frontmatter: {}, body: '', createdAt: '', updatedAt: '' },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      return pagesResponse([]);
    }));

    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByText('No pages yet')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Create your first page' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ doc: 'untitled' }));
  });

  test('wiki overview renders root pages as cards with excerpt and child count', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => cardPagesResponse([
      { id: 'r1', slug: 'guide', title: 'Guide', parentId: null, body: '# Guide\n\nHow to start.' },
      { id: 'r2', slug: 'faq', title: 'FAQ', parentId: null, body: 'Questions.' },
      { id: 'c1', slug: 'step-1', title: 'Step 1', parentId: 'r1', body: '' },
    ])));

    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);

    expect(await screen.findByText('Guide')).toBeInTheDocument();
    expect(screen.getByText('How to start.')).toBeInTheDocument();
    expect(screen.getByText(/1 page/i)).toBeInTheDocument();
    expect(screen.getByText('FAQ')).toBeInTheDocument();
  });

  test('expanding a card reveals its child subtree', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => cardPagesResponse([
      { id: 'r1', slug: 'guide', title: 'Guide', parentId: null, body: '# Guide\n\nHow to start.' },
      { id: 'r2', slug: 'faq', title: 'FAQ', parentId: null, body: 'Questions.' },
      { id: 'c1', slug: 'step-1', title: 'Step 1', parentId: 'r1', body: '' },
    ])));

    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);

    const card = (await screen.findByText('Guide')).closest('[data-testid^="wiki-card-"]')!;
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: /expand guide/i }));
    expect(await screen.findByText('Step 1')).toBeInTheDocument();
  });
});
