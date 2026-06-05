import { useMemo, useState } from 'react';
import { MessagesSquare } from 'lucide-react';
import { toast } from 'sonner';
import {
  useConversation,
  useCreateConversation,
  usePostMessage,
  type ConversationMessage,
} from '../../lib/api/conversations.ts';
import { formatApiError } from '../../lib/api/index.ts';
import { EmptyState } from '../views/empty-state.tsx';
import { MessageList } from './message-list.tsx';
import { ChatComposer } from './chat-composer.tsx';

/**
 * The cockpit chat body (T11): the operator conversation surface rendered inside
 * the layout-level panel. Owns "the current conversation":
 *   - empty state (no conversation): a centered greeting; the FIRST message
 *     creates a conversation, then posts to it — one linear async handler.
 *   - active conversation: the thread (seed + dedicated-SSE live-tail) + a
 *     composer blocked while a run is active (M14) or a send is in flight.
 *
 * `conversationId` may be supplied (resuming a recent chat); otherwise it starts
 * empty and is set once the first message creates a conversation.
 *
 * The id is passed to usePostMessage at MUTATE time, so a freshly-created
 * conversation is posted to in the same handler — no ref/effect bridge (the old
 * create-then-post race + lost-first-message bugs are gone, review #2/#3/#8).
 */
export function CockpitChat({ conversationId }: { conversationId?: string }) {
  const [activeId, setActiveId] = useState<string | undefined>(conversationId);
  const { thread, messages } = useConversation(activeId);

  const createConversation = useCreateConversation();
  const postMessage = usePostMessage();

  // A send in flight (create + post). Blocks the composer so a second Enter can't
  // double-create a conversation or race the first post (review #2).
  const [sending, setSending] = useState(false);
  // The just-sent user text, shown OPTIMISTICALLY until the seed/live-tail
  // carries the real row — so the message never disappears into the empty state
  // (review #7). Cleared once the real row (same body) lands.
  const [optimistic, setOptimistic] = useState<string | null>(null);

  const busy = sending || thread?.activeRunId != null;

  const handleSubmit = async (text: string) => {
    if (busy) return;
    setSending(true);
    setOptimistic(text);
    try {
      let id = activeId;
      if (!id) {
        const created = await createConversation.mutateAsync();
        id = created.id;
        setActiveId(id);
      }
      await postMessage.mutateAsync({ id, text });
    } catch (err) {
      // Surface the failure and restore the text so it isn't silently lost.
      toast.error(formatApiError(err));
      setOptimistic(null);
      throw err; // let the composer keep the text (it restores on a rejected submit)
    } finally {
      setSending(false);
    }
  };

  // Drop the optimistic row once the real one (same body, user role) is present.
  const optimisticRows = useMemo<ConversationMessage[]>(() => {
    if (optimistic === null) return [];
    const landed = messages.some((m) => m.role === 'user' && m.body === optimistic);
    if (landed) return [];
    return [
      {
        id: '__optimistic__',
        conversationId: activeId ?? '',
        seq: Number.MAX_SAFE_INTEGER,
        role: 'user',
        kind: 'text',
        body: optimistic,
        payload: null,
        runId: null,
        createdAt: Date.now(),
      },
    ];
  }, [optimistic, messages, activeId]);

  const shown = useMemo(() => [...messages, ...optimisticRows], [messages, optimisticRows]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length > 0 ? (
          <MessageList messages={shown} conversationId={activeId ?? ''} />
        ) : (
          <EmptyState
            icon={<MessagesSquare className="size-5" aria-hidden="true" />}
            title="How can the operator help?"
            description="Recent chat appears here."
          />
        )}
      </div>
      <ChatComposer onSubmit={handleSubmit} busy={busy} />
    </div>
  );
}
