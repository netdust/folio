import { useEffect, useRef } from 'react';

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
 * Open one EventSource to the workspace event stream and call `onEvent` for
 * each non-ping message. SSE TEACHES react-query WHEN data changed — consumers
 * pass an onEvent that calls queryClient.invalidateQueries(...). This hook owns
 * NO state and is NOT a source of truth.
 *
 * The server names each SSE frame after its kind (`event: <kind>`), so the
 * browser routes frames to addEventListener(kind), NOT 'message'. CONTRACT:
 * every consumer MUST pass an explicit `kinds` array — there is no unfiltered
 * firehose by design. We attach one listener per kind (+ a harmless 'message'
 * fallback for any unnamed frame). Reconnect is native EventSource behavior;
 * the server supports Last-Event-Id replay, so no hand-rolled backoff. Auth is
 * the same-origin session cookie (withCredentials).
 */
export function useEventStream(
  wslug: string,
  filters: EventStreamFilters,
  onEvent: (event: StreamedEvent) => void,
): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const query = buildQuery(filters);
  const kindsKey = (filters.kinds ?? []).join(',');

  useEffect(() => {
    if (!wslug) return;
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
    // `query` + `kindsKey` encode every connection-affecting field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wslug, query, kindsKey]);
}
