import { useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client.ts';
import { useEventStream } from './event-stream.ts';

export type ProviderStatus = 'healthy' | 'degraded';

export interface ProviderEntry {
  status: ProviderStatus;
  consecutiveFailures: number;
}

export interface ProviderHealth {
  anthropic: ProviderEntry;
  openai: ProviderEntry;
  openrouter: ProviderEntry;
  ollama: ProviderEntry;
}

export const providerHealthKeys = {
  detail: (wslug: string) => ['provider-health', wslug] as const,
};

// Provider-degradation SSE kinds (packages/shared/src/events.ts). These only
// SIGNAL that health changed — the handler invalidates the GET query, which is
// the source of truth. SSE never writes provider data.
const PROVIDER_KINDS = ['workspace.provider.degraded', 'workspace.provider.recovered'] as const;

/**
 * Provider health for a workspace. Backed by a real GET endpoint, so this is a
 * normal query; SSE only tells react-query WHEN to refetch (invalidate), never
 * carries the data itself.
 */
export function useProviderHealth(wslug: string) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: providerHealthKeys.detail(wslug),
    queryFn: () => client.get<ProviderHealth>(`/api/v1/w/${wslug}/provider-health`),
    staleTime: 60_000,
    enabled: !!wslug,
  });
  useEventStream(wslug, { kinds: [...PROVIDER_KINDS] }, () => {
    qc.invalidateQueries({ queryKey: providerHealthKeys.detail(wslug) });
  });
  return query;
}

export interface ReactorHealth {
  halted: boolean;
  errorClass: string | null;
}

export const reactorHealthKeys = {
  detail: (wslug: string) => ['reactor-health', wslug] as const,
};

// Reactor-health system events (apps/server/src/lib/event-dispatcher.ts). The
// `reactor.halted` payload carries `error_summary` — the error CLASS name only
// (mitigation 53: never the message or any tenant data). `reactor.recovered`
// carries just `{ reactor_id }`.
const REACTOR_KINDS = ['reactor.halted', 'reactor.recovered'] as const;

const REACTOR_INITIAL: ReactorHealth = { halted: false, errorClass: null };

/**
 * Reactor health for a workspace. Unlike useProviderHealth there is NO GET
 * endpoint — reactor health is broadcast-only via system SSE events. So this
 * hook holds last-seen state in a react-query cache entry that SSE writes via
 * `setQueryData`.
 *
 * This is the ONE justified exception to "SSE never writes data": every other
 * hook invalidates a fetch, but here there is no fetch to invalidate. The query
 * is seeded with the not-halted default and never refetches (staleTime
 * Infinity); the SSE handler is the only writer.
 */
export function useReactorHealth(wslug: string): ReactorHealth {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: reactorHealthKeys.detail(wslug),
    queryFn: () => REACTOR_INITIAL,
    initialData: REACTOR_INITIAL,
    staleTime: Number.POSITIVE_INFINITY,
    // `reactor.halted` is a live-only system event with NO SSE replay. If the
    // cache entry is garbage-collected on unmount (default gcTime 5m), a fresh
    // mount re-runs the seeding queryFn → halted:false, and a banner mounted
    // AFTER a halt began would wrongly read healthy until the next recovery
    // event. Keep the last-seen reactor state forever so unmount/remount cannot
    // GC-reset it back to the not-halted default.
    gcTime: Number.POSITIVE_INFINITY,
    enabled: !!wslug,
  });
  useEventStream(wslug, { kinds: [...REACTOR_KINDS] }, (event) => {
    const halted = event.kind === 'reactor.halted';
    const payload = (event.payload ?? {}) as { error_summary?: string };
    qc.setQueryData<ReactorHealth>(reactorHealthKeys.detail(wslug), {
      halted,
      errorClass: halted ? (payload.error_summary ?? 'unknown') : null,
    });
  });
  return query.data ?? REACTOR_INITIAL;
}
