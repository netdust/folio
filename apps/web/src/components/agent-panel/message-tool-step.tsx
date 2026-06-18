import { Check, ChevronRight, X } from 'lucide-react';
import type { ConversationMessage } from '../../lib/api/conversations.ts';
import { cn } from '../ui/cn.ts';
import { parseMessagePayload } from './payload.ts';

interface ToolStepPayload {
  tool?: string;
  summary?: string;
  status?: 'ok' | 'error' | 'pending';
}

/**
 * A `tool_step` message: one compact line summarizing a tool the operator ran —
 * a terminal-prompt glyph, the monospace tool name, a dimmed argument summary,
 * and a status tick. Rendered as a bordered "command" row (>_ tool arg ✓) to
 * read like a shell action. `status:'error'` is visibly distinct (destructive
 * tone); `status:'pending'` (a confirm-request placeholder) is muted.
 */
export function MessageToolStep({ message }: { message: ConversationMessage }) {
  const p = parseMessagePayload<ToolStepPayload>(message.payload);
  const status = p.status ?? 'ok';
  const isError = status === 'error';
  const isPending = status === 'pending';

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md border border-border-light bg-card px-2.5 py-1.5 text-xs',
        isError && 'border-danger/30',
      )}
    >
      <ChevronRight
        className={cn('size-3.5 shrink-0', isError ? 'text-destructive' : 'text-fg-3')}
        aria-hidden="true"
      />
      <code
        className={cn('font-mono text-[11px] shrink-0', isError ? 'text-destructive' : 'text-fg')}
      >
        {p.tool ?? 'tool'}
      </code>
      {p.summary ? <span className="truncate text-fg-3">{p.summary}</span> : null}
      <span className="ml-auto shrink-0" aria-label={`status: ${status}`}>
        {isError ? (
          <X className="size-3.5 text-destructive" aria-hidden="true" />
        ) : isPending ? (
          <span className="text-[11px] italic text-fg-3">pending</span>
        ) : (
          <Check className="size-3.5 text-success" aria-hidden="true" />
        )}
      </span>
    </div>
  );
}
