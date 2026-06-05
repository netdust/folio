import { useMemo, useRef, useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client, type ApiError } from './client.ts';

// ---------------------------------------------------------------------------
// Wire types — mirror apps/server/src/db/schema.ts (Message) + the
// GET /conversations/:id response shape (routes/conversations.ts). `createdAt`
// is a unix-ms number over the wire (timestamp_ms column serialized as a number).
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
): void {
  const onRowRef = useRef(onRow);
  onRowRef.current = onRow;

  useEffect(() => {
    if (!id) return;
    const es = new EventSource(`/api/v1/conversations/${id}/stream`, { withCredentials: true });
    const handle = (e: MessageEvent) => {
      if (!e.data) return; // ping heartbeats carry empty data
      try {
        onRowRef.current(JSON.parse(e.data) as ConversationMessage);
      } catch {
        // Malformed frame — ignore; the seed/refetch reconciles.
      }
    };
    es.addEventListener('message', handle);
    return () => {
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

  useConversationStream(id, (row) => {
    setLive((prev) => {
      const next = new Map(prev);
      next.set(row.id, row);
      return next;
    });
  });

  const messages = useMemo(
    () => mergeMessages(query.data?.messages ?? [], live),
    [query.data?.messages, live],
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

/**
 * Confirm a pending (HIGH-tier) op via its confirmation card. Same wire shape as
 * useButtonClick — a confirmation card IS a choice card whose "yes" option id
 * equals the pending_op id (server contract). Kept as a named hook so the
 * confirm flow reads intentfully at call sites; delegates to the click route.
 */
export function useConfirmPending(id: string) {
  return useButtonClick(id);
}
