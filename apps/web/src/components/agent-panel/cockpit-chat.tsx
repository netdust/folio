import { useEffect, useRef, useState } from 'react';
import { MessagesSquare } from 'lucide-react';
import {
  useConversation,
  useCreateConversation,
  usePostMessage,
} from '../../lib/api/conversations.ts';
import { MessageList } from './message-list.tsx';
import { ChatComposer } from './chat-composer.tsx';

/**
 * The cockpit chat body (T11): the operator conversation surface rendered inside
 * the layout-level panel. Owns "the current conversation":
 *   - empty state (no conversation): a centered greeting + a "Recent chat"
 *     affordance; the FIRST message creates a conversation, then posts to it.
 *   - active conversation: the thread (seed + dedicated-SSE live-tail via
 *     useConversation) + a composer blocked while a run is active (M14).
 *
 * `conversationId` may be supplied (e.g. resuming a recent chat); otherwise it
 * starts empty and is set once the first message creates a conversation.
 */
export function CockpitChat({ conversationId }: { conversationId?: string }) {
  const [activeId, setActiveId] = useState<string | undefined>(conversationId);
  const { thread, messages } = useConversation(activeId);

  const createConversation = useCreateConversation();
  // Always bound to the current active id. `usePostMessage('')` is inert (never
  // fired) until a conversation exists; once `activeId` is set the hook re-binds
  // to it on the next render, and the queued first message flushes via effect.
  const postMessage = usePostMessage(activeId ?? '');

  // A first message typed before any conversation exists is queued here; the
  // effect below flushes it once `activeId` is set (so the post targets the
  // freshly-created conversation through the re-bound usePostMessage).
  const pendingFirst = useRef<string | null>(null);

  useEffect(() => {
    if (activeId && pendingFirst.current !== null) {
      const text = pendingFirst.current;
      pendingFirst.current = null;
      postMessage.mutate({ text });
    }
    // postMessage is re-created each render; gating on activeId + the ref keeps
    // this to a single flush per created conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const busy = thread?.activeRunId != null;

  const handleSubmit = (text: string) => {
    if (activeId) {
      postMessage.mutate({ text });
      return;
    }
    // No conversation yet — create one, queue the first message, set the id; the
    // effect flushes the queued message once the hook re-binds to the new id.
    pendingFirst.current = text;
    void createConversation.mutateAsync().then((created) => {
      setActiveId(created.id);
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {activeId && messages.length > 0 ? (
          <MessageList messages={messages} conversationId={activeId} />
        ) : (
          <EmptyState />
        )}
      </div>
      <ChatComposer onSubmit={handleSubmit} busy={busy} />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <MessagesSquare className="size-8 text-fg-3" aria-hidden="true" />
      <p className="text-sm text-fg-2">How can the operator help?</p>
      <p className="text-xs text-fg-3">Recent chat appears here.</p>
    </div>
  );
}
