import type { QueryClient } from '@tanstack/react-query';
import { Outlet, createRootRouteWithContext, redirect, useRouterState } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/router-devtools';
import { Toaster } from '../components/ui/toast.tsx';
import { CommandPalette } from '../components/command-palette.tsx';
import { ApiError, client } from '../lib/api/client.ts';
import { authKeys, type MeResponse } from '../lib/api/auth.ts';

interface RouterContext {
  queryClient: QueryClient;
}

const PUBLIC_PATHS = new Set(['/login', '/magic']);

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ context, location }) => {
    if (PUBLIC_PATHS.has(location.pathname)) return;
    try {
      await context.queryClient.fetchQuery({
        queryKey: authKeys.me,
        queryFn: () => client.get<MeResponse>('/api/v1/auth/me'),
        staleTime: 60_000,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        throw redirect({ to: '/login', search: { redirect: location.href } });
      }
      throw err;
    }
  },
  component: RootLayout,
});

function RootLayout() {
  const routerState = useRouterState();
  const path = routerState.location.pathname;
  const isAuthRoute = path === '/login' || path === '/magic';
  return (
    <div className="h-screen bg-shell text-fg">
      {isAuthRoute ? (
        <main className="mx-auto max-w-5xl px-8 py-12">
          <Outlet />
        </main>
      ) : (
        <Outlet />
      )}
      <Toaster />
      {!isAuthRoute ? <CommandPalette /> : null}
      {import.meta.env.DEV ? <TanStackRouterDevtools /> : null}
    </div>
  );
}
