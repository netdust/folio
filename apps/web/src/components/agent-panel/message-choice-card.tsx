import type { ConversationMessage } from '../../lib/api/conversations.ts';
import { useButtonClick } from '../../lib/api/conversations.ts';
import { parseMessagePayload } from './payload.ts';
import { cn } from '../ui/cn.ts';

interface ChoiceOption {
  id: string;
  label: string;
}

interface ChoiceCardPayload {
  type?: string;
  prompt?: string;
  options?: ChoiceOption[];
  /** Set once a button is clicked — locks the card to the chosen option id. */
  chosen?: string;
  /** Present on a CONFIRMATION card (the id of the recorded HIGH-tier op). */
  pending_op?: string;
}

/**
 * A `choice_card` component: a prompt + option buttons. Clicking a button sends
 * the option's ID (M8 — NEVER the label text, which is operator-authored and
 * must not re-enter as trusted user input) via `useButtonClick`. Once a choice
 * is made (`payload.chosen` set, or a click in flight), the card LOCKS: the
 * chosen option stays highlighted and every option is disabled.
 */
export function MessageChoiceCard({
  message,
  conversationId,
}: {
  message: ConversationMessage;
  conversationId: string;
}) {
  const p = parseMessagePayload<ChoiceCardPayload>(message.payload);
  const click = useButtonClick(conversationId);

  const options = p.options ?? [];
  // Locked if the server recorded a choice OR a click is in flight/succeeded.
  const chosenId = p.chosen ?? (click.isSuccess ? click.variables?.optionId : undefined);
  const locked = chosenId !== undefined || click.isPending;

  return (
    <div className="rounded-lg border border-border-light bg-card px-3 py-2.5">
      {p.prompt ? <p className="mb-2 text-sm text-fg">{p.prompt}</p> : null}
      <div className="flex flex-wrap gap-2">
        {options.map((opt) => {
          const isChosen = chosenId === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              disabled={locked}
              aria-pressed={isChosen}
              onClick={() =>
                // M8 — send the option ID, never the label.
                click.mutate({ messageId: message.id, optionId: opt.id })
              }
              className={cn(
                'rounded-md border px-3 py-1.5 text-sm transition-colors duration-fast',
                isChosen
                  ? 'border-primary bg-primary/10 text-primary font-medium'
                  : 'border-border-light text-fg hover:border-border hover:bg-bg-2',
                locked && !isChosen && 'opacity-50 cursor-not-allowed',
                locked && isChosen && 'cursor-default',
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
