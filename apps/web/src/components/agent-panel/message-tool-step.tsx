import { Check, Wrench, X } from 'lucide-react';
import type { ConversationMessage } from '../../lib/api/conversations.ts';
import { parseMessagePayload } from './payload.ts';
import { cn } from '../ui/cn.ts';

interface ToolStepPayload {
  tool?: string;
  summary?: string;
  status?: 'ok' | 'error' | 'pending';
}

/**
 * A `tool_step` message: one compact line summarizing a tool the operator ran —
 * an icon, the summary, and a status tick. `status:'error'` is visibly distinct
 * (destructive tone); `status:'pending'` (a confirm-request placeholder) is muted.
 */
export function MessageToolStep({ message }: { message: ConversationMessage }) {
  const p = parseMessagePayload<ToolStepPayload>(message.payload);
  const status = p.status ?? 'ok';
  const isError = status === 'error';
  const isPending = status === 'pending';

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-1 text-xs',
        isError ? 'text-destructive' : 'text-fg-3',
      )}
    >
      <Wrench className="size-3 shrink-0" aria-hidden="true" />
      <code className="font-mono text-[11px] shrink-0">{p.tool ?? 'tool'}</code>
      <span className="truncate">{p.summary ?? ''}</span>
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
