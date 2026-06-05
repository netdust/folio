import { useMemo, useRef, useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client, type ApiError } from './client.ts';

// ---------------------------------------------------------------------------
// Wire types — mirror apps/server/src/db/schema.ts (Message) + the
// GET /conversations/:id response shape (routes/conversations.ts). `createdAt`
// is a unix-ms number over the wire: the server's `serializeMessage` converts
// the timestamp_ms Date → number at BOTH wire surfaces (seed + SSE frame), so
// this type is true for every real row (Cluster-5 /code-review fix, finding #3).
// ---------------------------------------------------------------------------

export type MessageRole = 'user' | 'operator';
export type MessageKind = 'text' | 'tool_step' | 'component';

export interface ConversationMessage {
  id: string;
  conversationId: string;
  seq: number;
  role: MessageRole;
  kind: MessageKind;
  body: string;
  /** JSON string for tool_step/component; null for text. Parsed by the renderer. */
  payload: string | null;
  runId: string | null;
  createdAt: number;
}

export interface ConversationThread {
  id: string;
  title: string;
  activeRunId: string | null;
  messages: ConversationMessage[];
}

// ---------------------------------------------------------------------------
// Query key factory (invariant 6 — no literal query keys anywhere)
// ---------------------------------------------------------------------------

export const conversationsKeys = {
  all: ['conversations'] as const,
  detail: (id: string) => [...conversationsKeys.all, id] as const,
};

// ---------------------------------------------------------------------------
// Live-tail merge — seed-then-tail (mirrors useActivityFeed's shape).
//
// The thread SEEDS from GET /conversations/:id (react-query). Live rows arrive
// on the dedicated conversation SSE and are LAYERED on top, keyed by message id
// — a live row supersedes the same id from the seed. Ordering is by `seq` (the
// per-conversation monotonic allocator), so a live row slots into place
// regardless of arrival order. Pure + exported so the merge is unit-testable
// without a real EventSource.
// ---------------------------------------------------------------------------

export function mergeMessages(
  seed: ConversationMessage[],
  live: Map<string, ConversationMessage>,
): ConversationMessage[] {
  const merged = new Map<string, ConversationMessage>();
  for (const m of seed) merged.set(m.id, m);
  // Live wins — overwrite the seeded row for the same id.
  for (const [id, m] of live) merged.set(id, m);
  return [...merged.values()].sort((a, b) => a.seq - b.seq);
}

// ---------------------------------------------------------------------------
// Live-tail hook — a raw EventSource on the DEDICATED conversation stream.
//
// NOT useEventStream: that hook is workspace-bound (/api/v1/w/:wslug/events,
// the trigger/document plane). Conversations are instance-level + owner-scoped
// and ride their own channel. The server names every conversation frame
// `message`; ping heartbeats carry empty data and are ignored. Auth is the
// same-origin session cookie (withCredentials). Native EventSource reconnect.
// ---------------------------------------------------------------------------

export function useConversationStream(
  id: string | undefined,
  onRow: (row: ConversationMessage) => void,
  onReconnect?: () => void,
): void {
  const onRowRef = useRef(onRow);
  onRowRef.current = onRow;
  const onReconnectRef = useRef(onReconnect);
  onReconnectRef.current = onReconnect;

  useEffect(() => {
    if (!id) return;
    const es = new EventSource(`/api/v1/conversations/${id}/stream`, { withCredentials: true });
    // The channel has NO replay (deliberate — the thread seeds from REST). So
    // ANY connect can miss rows written outside the live window:
    //   - the FIRST open: a row published in the gap between the seed's DB
    //     snapshot and this client's subscribe landing (seed/subscribe race);
    //   - a SUBSEQUENT open (reconnect after laptop sleep / proxy timeout / a
    //     ping gap): rows written during the dead window.
    // EventSource fires `open` on EVERY (re)connect, so we backfill on EVERY
    // open by refetching the seed (Cluster-5 /code-review fix #4 — the earlier
    // first-open-skip left the initial seed/subscribe race uncovered). Cheap
    // and idempotent: the refetch reconciles against the live Map by id.
    const onOpen = () => {
      onReconnectRef.current?.();
    };
    const handle = (e: MessageEvent) => {
      if (!e.data) return; // ping heartbeats carry empty data
      try {
        onRowRef.current(JSON.parse(e.data) as ConversationMessage);
      } catch {
        // Malformed frame — ignore; the seed/refetch reconciles.
      }
    };
    es.addEventListener('open', onOpen);
    es.addEventListener('message', handle);
    return () => {
      es.removeEventListener('open', onOpen);
      es.removeEventListener('message', handle);
      es.close();
    };
  }, [id]);
}

/**
 * The full conversation thread: react-query SEED + dedicated-SSE live-tail,
 * merged by message id (live wins) and ordered by seq. Mirrors useActivityFeed:
 * history from react-query, live deltas in local state, the union returned.
 */
export function useConversation(id: string | undefined): {
  thread: ConversationThread | undefined;
  messages: ConversationMessage[];
  isLoading: boolean;
} {
  const query = useQuery({
    queryKey: conversationsKeys.detail(id ?? ''),
    queryFn: () => client.get<ConversationThread>(`/api/v1/conversations/${id}`),
    enabled: !!id,
    staleTime: 30_000,
  });

  // Live deltas arriving after mount, keyed by message id (live wins on merge).
  const [live, setLive] = useState<Map<string, ConversationMessage>>(new Map());

  const queryClient = useQueryClient();
  useConversationStream(
    id,
    (row) => {
      setLive((prev) => {
        const next = new Map(prev);
        next.set(row.id, row);
        return next;
      });
    },
    // On every (re)connect, refetch the seed to backfill any rows missed outside
    // the live window (the channel has no replay). Cheap; closes the live-tail's
    // only hole. The prune effect below keeps `live` from growing unbounded.
    () => {
      if (id) void queryClient.invalidateQueries({ queryKey: conversationsKeys.detail(id) });
    },
  );

  // Cluster-5 /code-review fix (#5): prune `live` of rows the refreshed seed now
  // carries, so the Map doesn't grow unbounded across a session AND so a STALE
  // live row never supersedes a newer seed row by id. The seed is authoritative
  // once it includes a row; a copy-on-write Map that only ever grows would keep
  // an early `chosen`-less choice_card winning over the seed's `chosen` row
  // forever. Drop any live id present in the seed (the seed wins post-refetch).
  const seedMessages = query.data?.messages;
  useEffect(() => {
    if (!seedMessages || seedMessages.length === 0) return;
    setLive((prev) => {
      if (prev.size === 0) return prev;
      const seedIds = new Set(seedMessages.map((m) => m.id));
      let changed = false;
      const next = new Map(prev);
      for (const liveId of prev.keys()) {
        if (seedIds.has(liveId)) {
          next.delete(liveId);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [seedMessages]);

  // Seed is authoritative for any id it carries (post-refetch it reflects the
  // latest server state); live supplies only rows the seed hasn't caught up to.
  const messages = useMemo(
    () => mergeMessages(seedMessages ?? [], live),
    [seedMessages, live],
  );

  return { thread: query.data, messages, isLoading: query.isLoading };
}

// ---------------------------------------------------------------------------
// Mutations — all through the one `client` (invariant 6)
// ---------------------------------------------------------------------------

export interface CreateConversationResult {
  id: string;
}

export function useCreateConversation() {
  const qc = useQueryClient();
  return useMutation<CreateConversationResult, ApiError, { title?: string } | void>({
    mutationFn: (vars) =>
      client.post<CreateConversationResult>('/api/v1/conversations', vars ?? undefined),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: conversationsKeys.all });
    },
  });
}

export interface PostMessageResult {
  runId: string;
}

export function usePostMessage(id: string) {
  const qc = useQueryClient();
  return useMutation<PostMessageResult, ApiError, { text: string }>({
    mutationFn: (vars) =>
      client.post<PostMessageResult>(`/api/v1/conversations/${id}/messages`, vars),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: conversationsKeys.detail(id) });
    },
  });
}

export interface ButtonClickResult {
  runId?: string;
  confirmed?: boolean;
}

/**
 * Click a choice-card / confirmation button. Sends the chosen option ID — NEVER
 * the label (M8): the label is operator-authored and must not re-enter as
 * trusted user input. The server validates the id against the card's recorded
 * options[].id set. Used for BOTH ordinary choice cards and confirmation cards
 * (the server branches on whether the message carries a pending_op).
 */
export function useButtonClick(id: string) {
  const qc = useQueryClient();
  return useMutation<ButtonClickResult, ApiError, { messageId: string; optionId: string }>({
    mutationFn: ({ messageId, optionId }) =>
      client.post<ButtonClickResult>(
        `/api/v1/conversations/${id}/messages/${messageId}/click`,
        { optionId },
      ),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: conversationsKeys.detail(id) });
    },
  });
}
