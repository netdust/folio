import { useRuns, useRunsLiveSync } from '../../lib/api/runs.ts';
import { RunRow } from './run-row.tsx';

interface RunsHistorySectionProps {
  wslug: string;
  agentSlug: string;
  projects: string[]; // doc.frontmatter.projects (allow-list)
}

export function RunsHistorySection({ wslug, agentSlug, projects }: RunsHistorySectionProps) {
  // Primary project = first non-wildcard allow-list entry. v1 shows one project;
  // full cross-project rollup is deferred (E-FOLLOWUP-2). Hooks run
  // unconditionally (before the early return) to satisfy the rules of hooks.
  const primary = projects.find((p) => p !== '*');
  useRunsLiveSync(wslug, { agent: agentSlug });
  const runsQ = useRuns(wslug, primary ?? '', { agent: agentSlug });

  if (!primary) {
    return <div className="text-fg-3 text-sm py-8 text-center">No project scoped to this agent yet.</div>;
  }
  if (runsQ.isLoading) return <div className="text-fg-3 text-sm py-8 text-center">Loading runs…</div>;
  const runs = runsQ.data ?? [];
  if (runs.length === 0) return <div className="text-fg-3 text-sm py-8 text-center">No runs yet.</div>;
  return (
    <div>
      {runs.map((r) => (
        <RunRow key={r.id} run={r} />
      ))}
    </div>
  );
}
