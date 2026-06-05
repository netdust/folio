import type { ConversationMessage } from '../../lib/api/conversations.ts';
import { MessageText } from './message-text.tsx';
import { MessageToolStep } from './message-tool-step.tsx';
import { MessageLinkPanel } from './message-link-panel.tsx';
import { MessageChoiceCard } from './message-choice-card.tsx';
import { parseMessagePayload } from './payload.ts';

/**
 * Renders one conversation thread, dispatching each row to its renderer by
 * `kind`. A `component` row further branches on `payload.type` (link_panel /
 * choice_card). Presentational — the thread (seed + live-tail merge) is owned
 * by useConversation upstream.
 */
export function MessageList({
  messages,
  conversationId,
}: {
  messages: ConversationMessage[];
  conversationId: string;
}) {
  return (
    <div className="flex flex-col gap-2 p-3">
      {messages.map((m) => (
        <MessageRow key={m.id} message={m} conversationId={conversationId} />
      ))}
    </div>
  );
}

function MessageRow({
  message,
  conversationId,
}: {
  message: ConversationMessage;
  conversationId: string;
}) {
  if (message.kind === 'text') return <MessageText message={message} />;
  if (message.kind === 'tool_step') return <MessageToolStep message={message} />;
  if (message.kind === 'component') {
    const p = parseMessagePayload<{ type?: string }>(message.payload);
    if (p.type === 'link_panel') return <MessageLinkPanel message={message} />;
    if (p.type === 'choice_card') {
      return <MessageChoiceCard message={message} conversationId={conversationId} />;
    }
    return null;
  }
  return null;
}
