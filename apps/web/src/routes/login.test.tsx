import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { Route as LoginRoute } from './login.tsx';

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const login = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: LoginRoute.options.component,
  });
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <div>home</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([login, home]),
    history: createMemoryHistory({ initialEntries: ['/login'] }),
  });
  return { queryClient, router };
}

describe('LoginPage (password mode)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('pressing Enter in the password field submits the form', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      if (u.endsWith('/api/v1/auth/login') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ data: { user: { id: 'u1', email: 'a@b.c', name: 'A' } } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);

    await userEvent.type(await screen.findByLabelText(/Email/i), 'a@b.c');
    await userEvent.type(screen.getByLabelText(/Password/i), 'pw{Enter}');

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        ([url, init]) => String(url).endsWith('/api/v1/auth/login') && init?.method === 'POST',
      );
      expect(postCall).toBeDefined();
    });
  });

  it('Magic mode: Enter on email submits the magic-link request', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      if (u.endsWith('/api/v1/auth/magic-link/request') && init?.method === 'POST') {
        return new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);

    await userEvent.click(await screen.findByRole('button', { name: /Magic link/i }));
    await userEvent.type(screen.getByLabelText(/Email/i), 'a@b.c{Enter}');

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) => String(url).endsWith('/api/v1/auth/magic-link/request') && init?.method === 'POST',
      );
      expect(call).toBeDefined();
    });
  });

  it('Sign up mode: Enter submits, creates user, navigates to /', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      if (u.endsWith('/api/v1/auth/register') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ data: { user: { id: 'u1', email: 'new@x.y', name: 'New' } } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);

    await userEvent.click(await screen.findByRole('button', { name: /Sign up/i }));
    await userEvent.type(screen.getByLabelText(/Name/i), 'New');
    await userEvent.type(screen.getByLabelText(/Email/i), 'new@x.y');
    await userEvent.type(screen.getByLabelText(/Password/i), 'pw12345678{Enter}');

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) => String(url).endsWith('/api/v1/auth/register') && init?.method === 'POST',
      );
      expect(call).toBeDefined();
      const body = JSON.parse(String(call![1]!.body));
      expect(body).toEqual({ name: 'New', email: 'new@x.y', password: 'pw12345678' });
    });

    await waitFor(() => expect(screen.getByText('home')).toBeInTheDocument());
  });

  it('switching modes preserves typed email', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () =>
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    ));

    const { queryClient, router } = setup();
    render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);

    const emailInput = await screen.findByLabelText(/Email/i);
    await userEvent.type(emailInput, 'persist@me.io');
    await userEvent.click(screen.getByRole('button', { name: /Magic link/i }));
    const magicEmail = screen.getByLabelText(/Email/i) as HTMLInputElement;
    expect(magicEmail.value).toBe('persist@me.io');
  });
});
