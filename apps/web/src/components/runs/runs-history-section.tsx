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
  // Runs are project-scoped (`/w/:wslug/p/:pslug/runs`, resolved by SLUG). We
  // query each project the agent can run in and merge results newest-first.
  // Which projects?
  //  - WILDCARD allow-list (`['*']` — the default): the agent runs EVERYWHERE,
  //    so target every workspace project's slug.
  //  - CONCRETE allow-list: it stores project IDs, so resolve each ID → its
  //    slug via the workspace projects list (drop unresolvable/deleted IDs).
  // `useQueries` is a single hook call, legal in render even though the inner
  // array varies in length. Hooks run unconditionally (before any early
  // return) to satisfy the rules of hooks.
  const { data: workspaceProjects, isPending: projectsPending } = useProjects(wslug);
  const projectList = Array.isArray(workspaceProjects) ? workspaceProjects : [];
  const slugById = new Map(projectList.map((p) => [p.id, p.slug]));
  const isWildcard = projects.includes('*');
  const targetSlugs = isWildcard
    ? Array.from(new Set(projectList.map((p) => p.slug)))
    : Array.from(
        new Set(projects.map((id) => slugById.get(id)).filter((s): s is string => !!s)),
      );
  const filter = { agent: agentSlug };

  useRunsLiveSync(wslug, { agent: agentSlug });
  const runQueries = useQueries({
    queries: targetSlugs.map((slug) => ({
      queryKey: runsKeys.list(wslug, slug, filter),
      queryFn: () =>
        client.get<AgentRunDoc[]>(`/api/v1/w/${wslug}/p/${slug}/runs?agent=${encodeURIComponent(agentSlug)}`),
      staleTime: 30_000,
      enabled: !!wslug && !!slug,
    })),
  });

  // A genuinely unscoped agent — no wildcard AND no concrete project IDs.
  if (!isWildcard && projects.length === 0) {
    return <div className="text-fg-3 text-sm py-8 text-center">No project scoped to this agent yet.</div>;
  }
  if (targetSlugs.length === 0) {
    // Nothing to query yet. Distinguish:
    //  - projects still loading → transient "Loading…" (slugs will arrive).
    //  - loaded, still nothing → wildcard agent in an empty workspace (no
    //    projects), OR a concrete allow-list whose projects were all deleted.
    //    A TERMINAL state, not a perpetual spinner.
    return projectsPending ? (
      <div className="text-fg-3 text-sm py-8 text-center">Loading runs…</div>
    ) : isWildcard ? (
      <div className="text-fg-3 text-sm py-8 text-center">No projects in this workspace yet.</div>
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
