import { type ReactNode, createContext, useEffect, useMemo, useReducer, useRef } from 'react';
import type { EventStreamFilters, StreamedEvent } from './event-stream.ts';

/**
 * A registered subscriber. `onEventRef` is a ref so a consumer passing a new
 * callback identity each render does NOT churn the registration — only its
 * connection-affecting fields (wslug + declared kinds) drive reconnects.
 */
export interface Subscriber {
  filters: EventStreamFilters;
  onEventRef: { current: (event: StreamedEvent) => void };
}

export interface EventStreamRegistry {
  /** Register a subscriber. Returns an unregister fn for cleanup. */
  subscribe: (sub: Subscriber) => () => void;
}

/**
 * Default `null` === no provider mounted above. `useEventStream` branches on
 * this to fall back to opening its own EventSource (strictly additive: an
 * isolated test or a stray mount keeps working exactly as before the mux).
 */
export const EventStreamContext = createContext<EventStreamRegistry | null>(null);

/**
 * Replays the server's per-frame match logic (`apps/server/src/routes/events.ts`)
 * client-side so ONE widened socket can serve consumers with narrower filters.
 * Verified payload keys (events.ts lines 181, 217-234):
 *   project → event.projectId (TOP-LEVEL row field, not payload)
 *   parent  → payload.parent_id
 *   run     → payload.run_id
 *   agent   → payload.agent      (agent slug)
 *   table   → payload.table_id   (runs table id)
 *   kinds   → filters.kinds.includes(event.kind)
 * Each clause only NARROWS (AND-combined), mirroring the server.
 */
function matchesFilter(event: StreamedEvent, filters: EventStreamFilters): boolean {
  if (filters.kinds && filters.kinds.length > 0 && !filters.kinds.includes(event.kind)) {
    return false;
  }
  if (filters.project !== undefined && event.projectId !== filters.project) return false;
  const payload = event.payload as Record<string, unknown> | null | undefined;
  if (filters.parent !== undefined && payload?.parent_id !== filters.parent) return false;
  if (filters.run !== undefined && payload?.run_id !== filters.run) return false;
  if (filters.agent !== undefined && payload?.agent !== filters.agent) return false;
  if (filters.table !== undefined && payload?.table_id !== filters.table) return false;
  return true;
}

/**
 * Holds ONE EventSource per workspace. Each `useEventStream` call registers a
 * subscriber; the provider opens a single socket against the UNION of every
 * subscriber's declared kinds and fans each parsed frame out to the subscribers
 * whose filter matches it (client-side demux). This collapses the 5-7 sockets a
 * project view + slideover used to open into one, dodging the browser's
 * 6-per-origin HTTP/1.1 cap (audit H8 / "stuck on Saving…").
 *
 * Reconnect discipline mirrors the old per-hook effect: the connection re-opens
 * only when `[wslug, unionKey]` changes (a NEW kind entered the union); a frame
 * fanning out to a different subscriber set does NOT reconnect.
 */
export function EventStreamProvider({
  wslug,
  children,
}: {
  wslug: string;
  children: ReactNode;
}): ReactNode {
  // Mutable subscriber set, read inside the live socket's listeners. A ref (not
  // state) so registering/unregistering a subscriber never re-renders the
  // provider subtree — only a union change (below) re-opens the socket.
  const subscribersRef = useRef<Set<Subscriber>>(new Set());

  // The union (comma-joined, sorted) of every subscriber's declared kinds. Held
  // in a ref so register/unregister can recompute it synchronously; a reconnect
  // is signaled by bumping `forceReconnect` ONLY when the union actually changed.
  const unionRef = useRef<string>('');
  const [, forceReconnect] = useReducer((x: number) => x + 1, 0);

  const registry = useMemo<EventStreamRegistry>(
    () => ({
      subscribe: (sub: Subscriber) => {
        subscribersRef.current.add(sub);
        if (recomputeUnion(subscribersRef.current, unionRef)) forceReconnect();
        return () => {
          subscribersRef.current.delete(sub);
          if (recomputeUnion(subscribersRef.current, unionRef)) forceReconnect();
        };
      },
    }),
    // forceReconnect (useReducer dispatch) is referentially stable; subscribersRef
    // + unionRef are refs — so the registry is created once and never churns.
    [],
  );

  const unionKey = unionRef.current;

  // Deps [wslug, unionKey] encode every connection-affecting field. Subscribers
  // are read LIVE via subscribersRef inside the listener, so a new subscriber set
  // does NOT tear down the socket — only a kinds-union change (bumped via
  // forceReconnect → new unionKey) re-opens it.
  useEffect(() => {
    if (!wslug) return;
    const kinds = unionKey ? unionKey.split(',') : [];
    // CONTRACT: every consumer passes explicit kinds (no firehose); if the union
    // is empty there is nothing to listen for — skip opening a socket.
    if (kinds.length === 0) return;

    const sp = new URLSearchParams();
    sp.set('kinds', kinds.join(','));
    // NOTE: only `kinds` goes on the wire. project/parent/run/agent/table are
    // applied CLIENT-SIDE (matchesFilter) so one socket serves every consumer
    // regardless of their narrower filters.
    const es = new EventSource(`/api/v1/w/${wslug}/events?${sp.toString()}`, {
      withCredentials: true,
    });

    const handle = (e: MessageEvent) => {
      if (!e.data) return; // ping heartbeats carry empty data
      let event: StreamedEvent;
      try {
        event = JSON.parse(e.data) as StreamedEvent;
      } catch {
        return; // malformed frame — ignore; next invalidate re-syncs
      }
      // Fan out to every subscriber whose filter matches this frame.
      for (const sub of subscribersRef.current) {
        if (matchesFilter(event, sub.filters)) sub.onEventRef.current(event);
      }
    };

    es.addEventListener('message', handle);
    for (const k of kinds) es.addEventListener(k, handle);

    return () => {
      es.removeEventListener('message', handle);
      for (const k of kinds) es.removeEventListener(k, handle);
      es.close();
    };
  }, [wslug, unionKey]);

  return <EventStreamContext.Provider value={registry}>{children}</EventStreamContext.Provider>;
}

/**
 * Recompute the union of all subscribers' declared kinds. Mutates `unionRef` and
 * returns true iff it CHANGED (so the caller knows to trigger a reconnect).
 */
function recomputeUnion(subscribers: Set<Subscriber>, unionRef: { current: string }): boolean {
  const all = new Set<string>();
  for (const sub of subscribers) {
    for (const k of sub.filters.kinds ?? []) all.add(k);
  }
  const next = [...all].sort().join(',');
  if (next === unionRef.current) return false;
  unionRef.current = next;
  return true;
}
