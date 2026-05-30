import { useQueries } from '@tanstack/react-query';
import { client } from '../../lib/api/client.ts';
import { type AgentRunDoc, runsKeys, useRunsLiveSync } from '../../lib/api/runs.ts';
import { RunRow } from './run-row.tsx';

interface RunsHistorySectionProps {
  wslug: string;
  agentSlug: string;
  projects: string[]; // doc.frontmatter.projects (allow-list)
}

export function RunsHistorySection({ wslug, agentSlug, projects }: RunsHistorySectionProps) {
  // An agent's allow-list can scope MULTIPLE concrete projects. Runs are
  // project-scoped (there is no workspace-wide runs endpoint), so we query each
  // concrete project and merge the results newest-first. `useQueries` is a
  // single hook call, so it's legal in render even though the inner array
  // varies in length. Hooks run unconditionally (before any early return) to
  // satisfy the rules of hooks.
  const concreteProjects = projects.filter((p) => p !== '*');
  const filter = { agent: agentSlug };

  useRunsLiveSync(wslug, { agent: agentSlug });
  const runQueries = useQueries({
    queries: concreteProjects.map((p) => ({
      queryKey: runsKeys.list(wslug, p, filter),
      queryFn: () =>
        client.get<AgentRunDoc[]>(`/api/v1/w/${wslug}/p/${p}/runs?agent=${encodeURIComponent(agentSlug)}`),
      staleTime: 30_000,
      enabled: !!wslug && !!p,
    })),
  });

  if (concreteProjects.length === 0) {
    return <div className="text-fg-3 text-sm py-8 text-center">No project scoped to this agent yet.</div>;
  }
  if (runQueries.some((q) => q.isLoading)) {
    return <div className="text-fg-3 text-sm py-8 text-center">Loading runs…</div>;
  }
  const runs = runQueries
    .flatMap((q) => q.data ?? [])
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (runs.length === 0) {
    return <div className="text-fg-3 text-sm py-8 text-center">No runs yet.</div>;
  }
  return (
    <div>
      {runs.map((r) => (
        <RunRow key={r.id} run={r} />
      ))}
    </div>
  );
}
