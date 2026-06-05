import type { ConversationMessage } from '../../lib/api/conversations.ts';
import { cn } from '../ui/cn.ts';

/**
 * A `text` message. User turns render as a right-aligned plain bubble; operator
 * turns render left-aligned.
 *
 * NOTE (divergence from plan): the plan says "operator → markdown (reuse the
 * app's markdown renderer)". The app has NO read-only markdown renderer — the
 * only markdown surface is the Milkdown EDITOR (document body) and CodeMirror
 * (raw MD). Comment bodies render as plaintext with `whitespace-pre-wrap` (see
 * comment-row.tsx, which carries a TODO to add a real renderer later). To honor
 * "do NOT add a new md lib", operator text follows that established plaintext
 * convention. A real markdown renderer is a follow-up (same TODO as comments).
 */
export function MessageText({ message }: { message: ConversationMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words',
          isUser ? 'bg-primary/10 text-fg' : 'bg-card text-fg',
        )}
      >
        {message.body}
      </div>
    </div>
  );
}
