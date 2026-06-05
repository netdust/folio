/**
 * Operator cockpit chat — the conversation-thread output SINK (Task 4).
 *
 * The runner's output is abstracted into a small sink. There are two
 * implementations of "where a turn's output goes":
 *   - document thread → `postAgentComment` (the existing path, untouched).
 *   - conversation thread → `makeConversationSink` (this file): writes
 *     `text` / `tool_step` / `component` `messages` rows via `appendMessage`.
 *
 * The TYPE is defined here ONCE and imported wherever the sink is threaded
 * (`ToolContext`, `RunContext`). The interface is declared in T3 (the `ui`
 * tools reference `ctx.conversationSink.component(...)`); the implementation
 * `makeConversationSink` is wired in T4.
 */

import type { DB } from '../db/client.ts';
import { appendMessage } from '../services/conversations.ts';
import { conversationBus } from './conversation-bus.ts';

/**
 * The conversation-thread output abstraction. Each method appends one message
 * row of the matching `kind` to the conversation, stamped with the run id.
 */
export interface ConversationSink {
  /** Append a `text` message (a turn's prose output). */
  text(body: string): Promise<void>;
  /** Append a `tool_step` message summarizing one executed tool call. */
  toolStep(step: { tool: string; summary: string; status: 'ok' | 'error' }): Promise<void>;
  /** Append a `component` message (a `link_panel` / `choice_card` payload). */
  component(payload: Record<string, unknown>): Promise<void>;
}

/**
 * Build a `ConversationSink` bound to one conversation + run. Each method
 * appends a `messages` row of the matching `kind` via `appendMessage` (which
 * itself bypasses `txWithEvents` by design — invariant 5 deliberate exception),
 * stamping `runId` so the row is attributable to the turn that produced it.
 *
 * This is the conversation-thread implementation of the runner's output
 * abstraction; the document-thread implementation stays `postAgentComment`.
 */
export function makeConversationSink(
  db: DB,
  conversationId: string,
  runId: string,
): ConversationSink {
  return {
    async text(body: string): Promise<void> {
      const row = await appendMessage(db, { conversationId, role: 'operator', kind: 'text', body, runId });
      conversationBus.publish(conversationId, row);
    },
    async toolStep(step: { tool: string; summary: string; status: 'ok' | 'error' }): Promise<void> {
      const row = await appendMessage(db, {
        conversationId,
        role: 'operator',
        kind: 'tool_step',
        payload: step,
        runId,
      });
      conversationBus.publish(conversationId, row);
    },
    async component(payload: Record<string, unknown>): Promise<void> {
      const row = await appendMessage(db, {
        conversationId,
        role: 'operator',
        kind: 'component',
        payload,
        runId,
      });
      conversationBus.publish(conversationId, row);
    },
  };
}
