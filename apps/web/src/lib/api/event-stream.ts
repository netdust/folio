import { useContext, useEffect, useRef } from 'react';
import { EventStreamContext } from './event-stream-context.tsx';

export interface StreamedEvent {
  id: string;
  workspaceId?: string;
  projectId?: string | null;
  documentId?: string | null;
  kind: string;
  actor?: string | null;
  payload?: unknown;
  createdAt?: number;
}

export interface EventStreamFilters {
  project?: string;
  parent?: string;
  run?: string;
  agent?: string; // agent SLUG (server matches payload.agent)
  table?: string; // runs table id (server matches payload.table_id)
  kinds?: string[];
}

function buildQuery(filters: EventStreamFilters): string {
  const sp = new URLSearchParams();
  if (filters.project) sp.set('project', filters.project);
  if (filters.parent) sp.set('parent', filters.parent);
  if (filters.run) sp.set('run', filters.run);
  if (filters.agent) sp.set('agent', filters.agent);
  if (filters.table) sp.set('table', filters.table);
  if (filters.kinds && filters.kinds.length > 0) sp.set('kinds', filters.kinds.join(','));
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Subscribe to the workspace event stream and call `onEvent` for each frame
 * matching `filters`. SSE TEACHES react-query WHEN data changed — consumers pass
 * an onEvent that calls queryClient.invalidateQueries(...). This hook owns NO
 * state and is NOT a source of truth.
 *
 * CONTRACT: every consumer MUST pass an explicit `kinds` array — there is no
 * unfiltered firehose by design. Reconnect (when the kinds union changes) and
 * Last-Event-Id replay are handled by the provider / native EventSource; auth is
 * the same-origin session cookie (withCredentials).
 *
 * TOPOLOGY (audit H8 — SSE mux): when an `EventStreamProvider` is mounted above
 * (the normal workspace case), this hook does NOT open a socket. It registers
 * `{ filters, onEventRef }` with the provider, which opens ONE EventSource per
 * workspace against the UNION of every consumer's kinds and demuxes each frame
 * back to the matching subscribers. This collapses the 5-7 sockets a project
 * view + slideover used to open into one, dodging the 6-per-origin cap.
 *
 * FALLBACK (strictly additive): when NO provider is mounted (an isolated test,
 * a stray mount), the context is `null` and this hook opens + filters its own
 * EventSource exactly as it did before the mux — so no consumer can break.
 */
export function useEventStream(
  wslug: string,
  filters: EventStreamFilters,
  onEvent: (event: StreamedEvent) => void,
): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const registry = useContext(EventStreamContext);

  const query = buildQuery(filters);
  const kindsKey = (filters.kinds ?? []).join(',');

  // PROVIDER PATH: register a subscriber; the provider owns the socket + demux.
  // Re-register only when a connection-affecting field changes (filters identity
  // is captured in [wslug, query, kindsKey]); onEvent is read via onEventRef so a
  // new callback identity does NOT churn the registration.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps [wslug, query, kindsKey] encode every registration-affecting field; `filters`/`onEvent`/`registry` are read live to avoid churning the subscription on a new identity
  useEffect(() => {
    if (!wslug || !registry) return;
    const unsubscribe = registry.subscribe({ filters, onEventRef });
    return unsubscribe;
  }, [wslug, query, kindsKey, registry]);

  // FALLBACK PATH: no provider above → open + filter our own socket, as before.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps [wslug, query, kindsKey] encode every connection-affecting field; onEvent is read via onEventRef so a new callback identity does NOT tear down the SSE connection
  useEffect(() => {
    if (!wslug || registry) return;
    const es = new EventSource(`/api/v1/w/${wslug}/events${query}`, { withCredentials: true });

    const handle = (e: MessageEvent) => {
      if (!e.data) return; // ping heartbeats carry empty data
      try {
        onEventRef.current(JSON.parse(e.data) as StreamedEvent);
      } catch {
        // Malformed frame — ignore; the next invalidate re-syncs anyway.
      }
    };

    es.addEventListener('message', handle);
    const kinds = filters.kinds ?? [];
    for (const k of kinds) es.addEventListener(k, handle);

    return () => {
      es.removeEventListener('message', handle);
      for (const k of kinds) es.removeEventListener(k, handle);
      es.close();
    };
  }, [wslug, query, kindsKey, registry]);
}
