import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client, type ApiError } from './client.ts';
import type { DocumentSummary } from './documents.ts';
import { useEventStream } from './event-stream.ts';

/**
 * A run IS a `documents` row of type 'agent_run' — same shape as every other
 * document (see DocumentSummary). The run's AUTHORITATIVE status is the
 * top-level `status` column (`planning`/`running`/`awaiting_approval`/
 * `completed`/`failed`/`rejected`); `frontmatter.agent_slug` holds the agent.
 */
export interface AgentRunDoc extends DocumentSummary {
  type: 'agent_run';
}

export interface RunsFilter {
  status?: string;
  agent?: string; // slug
  since?: string; // ISO
}

export interface RunMutationResult {
  run_id: string;
  status: string;
}

export const runsKeys = {
  all: ['runs'] as const,
  list: (wslug: string, pslug: string, filter: RunsFilter = {}) =>
    [...runsKeys.all, wslug, pslug, 'list', filter] as const,
  detail: (wslug: string, runId: string) => [...runsKeys.all, wslug, 'detail', runId] as const,
};

function toSearch(filter: RunsFilter): string {
  const sp = new URLSearchParams();
  if (filter.status) sp.set('status', filter.status);
  if (filter.agent) sp.set('agent', filter.agent);
  if (filter.since) sp.set('since', filter.since);
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

export function useRuns(wslug: string, pslug: string, filter: RunsFilter = {}) {
  return useQuery({
    queryKey: runsKeys.list(wslug, pslug, filter),
    queryFn: () =>
      client.get<AgentRunDoc[]>(`/api/v1/w/${wslug}/p/${pslug}/runs${toSearch(filter)}`),
    staleTime: 30_000,
    enabled: !!wslug && !!pslug,
  });
}

/**
 * Workspace-scoped recent-runs list (across all projects the caller can read).
 * Backs the Agent Activity feed's history backfill — see activity-feed.ts.
 */
export function useWorkspaceRuns(wslug: string, opts: { limit?: number } = {}) {
  return useQuery({
    queryKey: [...runsKeys.all, wslug, 'workspace-list', opts.limit ?? 50] as const,
    queryFn: () =>
      client.get<AgentRunDoc[]>(
        `/api/v1/w/${wslug}/runs${opts.limit ? `?limit=${opts.limit}` : ''}`,
      ),
    staleTime: 30_000,
    enabled: !!wslug,
  });
}

export function useRun(wslug: string, runId: string | undefined) {
  return useQuery({
    queryKey: runsKeys.detail(wslug, runId ?? ''),
    queryFn: () => client.get<AgentRunDoc>(`/api/v1/w/${wslug}/runs/${runId}`),
    staleTime: 10_000,
    enabled: !!wslug && !!runId,
  });
}

export function useCancelRun(wslug: string) {
  const qc = useQueryClient();
  return useMutation<RunMutationResult, ApiError, { runId: string }>({
    mutationFn: ({ runId }) =>
      client.post<RunMutationResult>(`/api/v1/w/${wslug}/runs/${runId}/cancel`),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: runsKeys.all });
    },
  });
}

export function useRetryRun(wslug: string) {
  const qc = useQueryClient();
  return useMutation<RunMutationResult, ApiError, { runId: string }>({
    mutationFn: ({ runId }) =>
      client.post<RunMutationResult>(`/api/v1/w/${wslug}/runs/${runId}/retry`),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: runsKeys.all });
    },
  });
}

// The exactly-six run-lifecycle event kinds (packages/shared/src/events.ts).
const RUN_KINDS = [
  'agent.run.started',
  'agent.run.awaiting_approval',
  'agent.run.running',
  'agent.run.completed',
  'agent.run.failed',
  'agent.run.rejected',
] as const;

/**
 * Subscribe to run-lifecycle events for one filter and invalidate the runs
 * queries on receipt. THIS is the whole realtime story for runs: SSE only
 * tells react-query "something changed, refetch" — it is NEVER a second source
 * of truth. The handler does nothing but invalidateQueries. Mount once near a
 * runs view.
 */
export function useRunsLiveSync(
  wslug: string,
  filter: { agent?: string; table?: string; run?: string } = {},
) {
  const qc = useQueryClient();
  useEventStream(wslug, { ...filter, kinds: [...RUN_KINDS] }, () => {
    qc.invalidateQueries({ queryKey: runsKeys.all });
  });
}
