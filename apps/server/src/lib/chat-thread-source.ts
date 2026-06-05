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
import { getThread } from '../services/conversations.ts';

/** Defensive parse of a stored `payload` (free `text` column). A malformed row
 *  degrades to `{}` rather than throwing out of the whole replay — the thread
 *  must always be reconstructable (same posture as the markdown serializer). */
function parsePayload<T extends Record<string, unknown>>(payload: string | null): T {
  if (!payload) return {} as T;
  try {
    return JSON.parse(payload) as T;
  } catch {
    return {} as T;
  }
}

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
 * Build the runner's provider `Message[]` from a conversation thread. Mirrors
 * the shape `buildInitialMessages` returns so `runLoop` consumes it unchanged.
 *
 *   - `role:'user'` `text`        → `{ role:'user', content }`
 *   - `role:'operator'` `text`    → `{ role:'assistant', content }`
 *   - `tool_step`                 → `{ role:'assistant', content: '<ran tool: …>' }`
 *   - `component`                 → `{ role:'assistant', content: '<asked: … (user chose: …)>' }`
 *
 * Empty bodies are dropped (a provider rejects an empty-content message).
 */
export async function buildConversationMessages(
  db: DB,
  conversationId: string,
): Promise<Message[]> {
  const rows: MessageRow[] = await getThread(db, conversationId);
  const out: Message[] = [];
  for (const m of rows) {
    if (m.kind === 'text') {
      if (!m.body || m.body.trim().length === 0) continue;
      out.push(
        m.role === 'user'
          ? { role: 'user', content: m.body }
          : { role: 'assistant', content: m.body },
      );
    } else if (m.kind === 'tool_step') {
      out.push({ role: 'assistant', content: summarizeToolStep(m.payload) });
    } else if (m.kind === 'component') {
      out.push({ role: 'assistant', content: summarizeComponent(m.payload) });
    }
  }
  return out;
}
