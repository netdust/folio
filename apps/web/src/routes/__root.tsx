import type { QueryClient } from '@tanstack/react-query';
import { Outlet, createRootRouteWithContext, Link } from '@tanstack/react-router';

interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
});

function RootLayout() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-default">
        <div className="mx-auto flex max-w-6xl items-baseline justify-between px-6 py-4">
          <Link to="/" className="font-display text-2xl tracking-tight">
            Folio
          </Link>
          <nav className="flex gap-6 text-sm text-muted">
            <Link to="/" className="hover:text-current">
              Home
            </Link>
            <Link to="/login" className="hover:text-current">
              Sign in
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-10">
        <Outlet />
      </main>
    </div>
  );
}
