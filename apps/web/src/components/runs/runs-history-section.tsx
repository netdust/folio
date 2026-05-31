import { useQueries } from '@tanstack/react-query';
import { client } from '../../lib/api/client.ts';
import { useProjects } from '../../lib/api/projects.ts';
import { type AgentRunDoc, runsKeys, useRunsLiveSync } from '../../lib/api/runs.ts';
import { RunRow } from './run-row.tsx';

interface RunsHistorySectionProps {
  wslug: string;
  agentSlug: string;
  projects: string[]; // doc.frontmatter.projects (allow-list — stores project IDs)
}

export function RunsHistorySection({ wslug, agentSlug, projects }: RunsHistorySectionProps) {
  // An agent's allow-list can scope MULTIPLE concrete projects. Runs are
  // project-scoped (`/w/:wslug/p/:pslug/runs`, resolved by SLUG), but the
  // allow-list stores project IDs — so we resolve each ID → its slug via the
  // workspace projects list before querying. Each concrete project's runs are
  // merged newest-first. `useQueries` is a single hook call, so it's legal in
  // render even though the inner array varies in length. Hooks run
  // unconditionally (before any early return) to satisfy the rules of hooks.
  const { data: workspaceProjects, isPending: projectsPending } = useProjects(wslug);
  const projectList = Array.isArray(workspaceProjects) ? workspaceProjects : [];
  const slugById = new Map(projectList.map((p) => [p.id, p.slug]));
  // Map allow-list IDs → slugs; drop the wildcard and any ID not yet resolved
  // (projects still loading or removed). Stable, deduped.
  const concreteSlugs = Array.from(
    new Set(projects.filter((p) => p !== '*').map((id) => slugById.get(id)).filter((s): s is string => !!s)),
  );
  const filter = { agent: agentSlug };

  useRunsLiveSync(wslug, { agent: agentSlug });
  const runQueries = useQueries({
    queries: concreteSlugs.map((slug) => ({
      queryKey: runsKeys.list(wslug, slug, filter),
      queryFn: () =>
        client.get<AgentRunDoc[]>(`/api/v1/w/${wslug}/p/${slug}/runs?agent=${encodeURIComponent(agentSlug)}`),
      staleTime: 30_000,
      enabled: !!wslug && !!slug,
    })),
  });

  // No concrete projects in the allow-list (wildcard-only, or none resolved).
  if (projects.filter((p) => p !== '*').length === 0) {
    return <div className="text-fg-3 text-sm py-8 text-center">No project scoped to this agent yet.</div>;
  }
  if (concreteSlugs.length === 0) {
    // The allow-list has concrete IDs but none resolve to a slug. Distinguish:
    //  - projects still loading → transient "Loading…" (slugs will arrive).
    //  - projects loaded, still no match → the scoped project(s) were deleted;
    //    a TERMINAL state, not a perpetual spinner.
    return projectsPending ? (
      <div className="text-fg-3 text-sm py-8 text-center">Loading runs…</div>
    ) : (
      <div className="text-fg-3 text-sm py-8 text-center">
        The project(s) this agent was scoped to no longer exist.
      </div>
    );
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
