import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { api } from '../lib/api.ts';

export const Route = createFileRoute('/')({
  component: HomePage,
});

interface Me {
  user: { id: string; email: string; name: string };
}

function HomePage() {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<Me>('/api/auth/me').catch(() => null),
    retry: false,
  });

  if (me.isPending) {
    return <p className="text-fg-3">Loading…</p>;
  }

  if (!me.data) {
    return (
      <section className="max-w-2xl">
        <h1 className="text-4xl font-medium tracking-tight">Markdown is the work.</h1>
        <p className="mt-6 text-lg text-fg-2">
          Folio is a lightweight project space for humans and agents. One markdown file
          is one work item. Pages live next to tasks. Your agents can read and write
          everything natively.
        </p>
        <div className="mt-10 flex gap-3">
          <Link
            to="/login"
            className="rounded-pill bg-primary px-5 py-2.5 text-sm text-primary-fg hover:opacity-90 transition-opacity duration-fast"
          >
            Sign in
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section>
      <h1 className="text-3xl font-medium tracking-tight">
        Welcome back, {me.data.user.name}.
      </h1>
      <p className="mt-4 text-fg-2">
        Phase 0 stub. Workspace selection, projects, and the document grid land in Phase 1.
      </p>
      <div className="mt-8 rounded-lg border border-border-light p-6">
        <p className="font-mono text-sm text-fg-2">{me.data.user.email}</p>
        <p className="mt-2 font-mono text-xs text-fg-3">user_id: {me.data.user.id}</p>
      </div>
    </section>
  );
}
