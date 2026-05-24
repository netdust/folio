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
import { ProjectCreate } from './project-create.tsx';

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <ProjectCreate wslug="main" open onOpenChange={() => {}} />,
  });
  const workItems = createRoute({
    getParentRoute: () => rootRoute,
    path: '/w/$wslug/p/$pslug/work-items',
    component: () => <div>navigated to work-items</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([home, workItems]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return { queryClient, router };
}

describe('ProjectCreate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('auto-derives slug from name and submits to create the project', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith('/api/v1/w/main/projects') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            data: {
              id: 'p1',
              workspaceId: 'w1',
              slug: 'spring',
              name: 'Spring',
              icon: null,
              description: null,
              archivedAt: null,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const nameInput = await screen.findByLabelText(/Name/);
    await userEvent.type(nameInput, 'Spring');
    // Slug should auto-derive
    await waitFor(() => {
      expect(screen.getByLabelText(/Slug/)).toHaveValue('spring');
    });
    await userEvent.click(screen.getByRole('button', { name: 'Create', exact: true }));
    await waitFor(() => expect(screen.getByText('navigated to work-items')).toBeInTheDocument());

    const postCall = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith('/api/v1/w/main/projects') && init?.method === 'POST',
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse(postCall![1]!.body as string) as unknown;
    expect(body).toEqual({ name: 'Spring', slug: 'spring' });
  });

  it('surfaces SLUG_CONFLICT as an inline field error, not a toast', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ error: { code: 'SLUG_CONFLICT', message: 'Slug already in use' } }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const { queryClient, router } = setup();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    const nameInput = await screen.findByLabelText(/Name/);
    await userEvent.type(nameInput, 'Spring');
    await userEvent.click(screen.getByRole('button', { name: 'Create', exact: true }));
    await waitFor(() =>
      expect(screen.getByText(/already in use|already taken|Slug already/i)).toBeInTheDocument(),
    );
    const slugInput = screen.getByLabelText(/Slug/i);
    const errorEl = await screen.findByRole('alert');
    expect(slugInput.parentElement).toContainElement(errorEl);
  });
});
