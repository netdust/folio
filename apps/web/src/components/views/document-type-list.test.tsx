import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { DocumentTypeList } from './document-type-list.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(initialPath = '/w/acme/p/web/agents') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/agents',
    component: () => (
      <DocumentTypeList wslug="acme" pslug="web" type="agent" title="Agents" />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  return { qc, router };
}

describe('DocumentTypeList', () => {
  it('lists documents of the given type with title + slug', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.includes('/documents?type=agent')) {
          return new Response(
            JSON.stringify({
              data: {
                data: [
                  {
                    id: 'd1',
                    slug: 'triage-bot',
                    type: 'agent',
                    title: 'Triage Bot',
                    status: null,
                    parentId: null,
                    frontmatter: {},
                    createdAt: '2026-05-25T00:00:00.000Z',
                    updatedAt: '2026-05-25T00:00:00.000Z',
                    lastTouchedAt: null,
                  },
                ],
                nextCursor: null,
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );

    const { qc, router } = setup();
    render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Triage Bot')).toBeInTheDocument();
    expect(screen.getByText(/triage-bot/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /agents/i })).toBeInTheDocument();
  });

  it('shows an empty-state message when there are no documents of this type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ data: { data: [], nextCursor: null } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    const { qc, router } = setup();
    render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText(/no agents yet/i)).toBeInTheDocument();
    });
  });
});
