/**
 * Operator cockpit chat — the conversation-thread message SOURCE (Task 4).
 *
 * The runner's message source is abstracted. There are two implementations of
 * "what history does the model see this turn":
 *   - document thread → `buildInitialMessages` / `buildResumeMessages` (the
 *     existing path, untouched): the parent doc body + comments, fenced by
 *     `buildUntrustedContext` (the parent/comment content is UNTRUSTED).
 *   - conversation thread → `buildConversationMessages` (this file): replays
 *     the stored `messages` rows into provider `Message[]`.
 *
 * TRUST NOTE (threat model M9): the CONVERSATION itself is trusted — the user
 * is the customer, typing directly. So no untrusted-input envelope is wrapped
 * around the replayed turns here. Only NON-conversation content the operator
 * pulls DURING a turn (work-item bodies, documents read via tools) is fenced,
 * and that fencing lives on the tool-read path (`buildUntrustedContext` in the
 * run loop), not in the source. The source only replays the trusted thread.
 */

import { type Message as MessageRow } from '../db/schema.ts';
import type { DB } from '../db/client.ts';
import { type Message } from './ai/provider.ts';
// parsePayload is shared with the markdown serializer (one guard, one degrade
// policy — deduped per Cluster-2 /code-review).
import { getThread, parsePayload } from '../services/conversations.ts';

/** Compact a `tool_step` row into a single assistant line so the model sees what
 *  it already did this conversation without re-streaming a full tool round-trip. */
function summarizeToolStep(payload: string | null): string {
  const p = parsePayload<{ tool?: string; summary?: string; status?: string }>(payload);
  return `<ran tool: ${p.tool ?? 'unknown'} — ${p.summary ?? ''} (${p.status ?? ''})>`;
}

/** Compact a `component` row (link_panel / choice_card) into an assistant line.
 *  For a choice_card, fold in the user's `chosen` option so the operator sees
 *  the pick on resume (the choice is the user's answer to its own question). */
function summarizeComponent(payload: string | null): string {
  const p = parsePayload<{
    type?: string;
    title?: string;
    prompt?: string;
    chosen?: string;
  }>(payload);
  if (p.type === 'link_panel') {
    return `<showed link panel: ${p.title ?? ''}>`;
  }
  if (p.type === 'choice_card') {
    const chosen = p.chosen ? ` (user chose: ${p.chosen})` : '';
    return `<asked: ${p.prompt ?? ''}${chosen}>`;
  }
  return '<component>';
}

/**
 * The most-recent N message rows replayed into the model each turn. The thread
 * is the model's only memory for a conversation run (the walled-off path has no
 * agent_run token ceiling), so an UNBOUNDED replay would grow BYOK input tokens
 * (the customer pays per turn) and turn latency linearly with chat length
 * (Cluster-6 perf review). A tail window bounds both: the operator is turn-based
 * and the recent turns carry the working context; older history is dropped.
 * Generous enough that normal "set up a project" sessions replay in full.
 */
export const CONVERSATION_HISTORY_WINDOW = 60;

/**
 * Build the runner's provider `Message[]` from a conversation thread. Mirrors
 * the shape `buildInitialMessages` returns so `runLoop` consumes it unchanged.
 *
 *   - `role:'user'` `text`        → `{ role:'user', content }`
 *   - `role:'operator'` `text`    → `{ role:'assistant', content }`
 *   - `tool_step`                 → `{ role:'assistant', content: '<ran tool: …>' }`
 *   - `component`                 → `{ role:'assistant', content: '<asked: … (user chose: …)>' }`
 *
 * Empty bodies are dropped (a provider rejects an empty-content message). Only
 * the last `CONVERSATION_HISTORY_WINDOW` rows are replayed (bounded cost).
 *
 * CRITICAL — roles MUST alternate. A single operator turn becomes MANY rows
 * (a `tool_step` per tool call + a `component` per card + the final `text`),
 * which all map to `assistant`. The Anthropic Messages API rejects consecutive
 * same-role messages with a 400 ("roles must alternate"), and our provider
 * adapter maps rows 1:1 (it does NOT merge). So a turn with several tool steps
 * replays as `user, assistant, assistant, …` and the NEXT turn's request 400s →
 * the run fails with `provider_error`. This bit the confirm-resume path: after a
 * HIGH-tier card the thread had 7+ consecutive assistant rows, so the resume
 * turn could never reach the model. `rowsToMessages` COALESCES consecutive
 * same-role messages into one (joining content with blank lines) so the replayed
 * sequence always alternates. Pure + exported for unit testing without a DB.
 */
export function rowsToMessages(rows: readonly MessageRow[]): Message[] {
  const out: Message[] = [];
  const pushCoalesced = (role: 'user' | 'assistant', content: string) => {
    const last = out[out.length - 1];
    if (last && last.role === role) {
      // Same role as the previous message → merge, so the sequence alternates.
      last.content = `${last.content}\n\n${content}`;
      return;
    }
    out.push({ role, content });
  };
  for (const m of rows) {
    if (m.kind === 'text') {
      if (!m.body || m.body.trim().length === 0) continue;
      pushCoalesced(m.role === 'user' ? 'user' : 'assistant', m.body);
    } else if (m.kind === 'tool_step') {
      pushCoalesced('assistant', summarizeToolStep(m.payload));
    } else if (m.kind === 'component') {
      pushCoalesced('assistant', summarizeComponent(m.payload));
    }
  }
  return out;
}

export async function buildConversationMessages(
  db: DB,
  conversationId: string,
): Promise<Message[]> {
  const all: MessageRow[] = await getThread(db, conversationId);
  // Tail window: keep the most recent rows (getThread is seq-ascending, so the
  // window is the END of the array — preserving chronological order).
  const rows =
    all.length > CONVERSATION_HISTORY_WINDOW
      ? all.slice(all.length - CONVERSATION_HISTORY_WINDOW)
      : all;
  return rowsToMessages(rows);
}
