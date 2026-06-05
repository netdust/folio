/**
 * Operator cockpit chat — conversation/message persistence.
 *
 * DELIBERATE EXCEPTION to invariant 5 (every write emits an event): these writes
 * use PLAIN `db` transactions and emit NO events. Chat persistence is walled off
 * from the SSE stream + trigger-matcher by design (see ARCHITECTURE-INVARIANTS.md
 * "Deliberate exceptions"; threat model M10). Never route these through
 * `txWithEvents` / `emitEvent`.
 *
 * `seq` is allocated monotonically per conversation via `MAX(seq) + 1` inside the
 * same transaction as the insert. SQLite's writer lock serializes the max + insert
 * so the value is unique within a conversation. The single-active-turn CAS (M14,
 * Task 6) is the outer guarantee that two turns never append concurrently; this
 * allocator is correct within that model.
 */

import { and, eq, max } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { conversations, messages, type Message } from '../db/schema.ts';

export async function createConversation(
  db: DB,
  input: { createdBy: string; operatorAgentId: string; title: string },
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  // created_at / updated_at default via SQL (unixepoch() * 1000) — omit on insert.
  await db.insert(conversations).values({
    id,
    title: input.title,
    createdBy: input.createdBy,
    operatorAgentId: input.operatorAgentId,
    activeRunId: null,
  });
  return { id };
}

export async function appendMessage(
  db: DB,
  input: {
    conversationId: string;
    role: 'user' | 'operator';
    kind: 'text' | 'tool_step' | 'component';
    body?: string;
    payload?: unknown;
    runId?: string;
  },
): Promise<Message> {
  return db.transaction(async (tx) => {
    const [maxRow] = await tx
      .select({ value: max(messages.seq) })
      .from(messages)
      .where(eq(messages.conversationId, input.conversationId));
    const seq = (maxRow?.value ?? 0) + 1;
    const inserted = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      seq,
      role: input.role,
      kind: input.kind,
      body: input.body ?? '',
      payload: input.payload === undefined ? null : JSON.stringify(input.payload),
      runId: input.runId ?? null,
    };
    // `.returning()` yields the full row WITH the SQL-defaulted created_at in one
    // round-trip (verified on bun:sqlite + drizzle; pattern used in agent-runs.ts),
    // avoiding a re-read SELECT and an unsafe `as Message` cast.
    const [row] = await tx.insert(messages).values(inserted).returning();
    if (!row) throw new Error('appendMessage: insert returned no row');
    await tx
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, input.conversationId));
    return row;
  });
}

export async function getThread(db: DB, conversationId: string): Promise<Message[]> {
  return db.query.messages.findMany({
    where: eq(messages.conversationId, conversationId),
    orderBy: (m, { asc }) => [asc(m.seq)],
  });
}

/**
 * Load a single `component` message belonging to a conversation, or undefined.
 * Used by the button-click route (Task 7) to validate an `optionId` against the
 * card's RECORDED `options[].id` set (M8 — the click sends an id, never label
 * text, and an out-of-set id is rejected). Scoped by conversation id so a click
 * cannot reach another conversation's card.
 */
export async function getMessage(
  db: DB,
  conversationId: string,
  messageId: string,
): Promise<Message | undefined> {
  return db.query.messages.findFirst({
    where: and(eq(messages.conversationId, conversationId), eq(messages.id, messageId)),
  });
}

/**
 * Lock a `choice_card` to the chosen option (sets `payload.chosen`). The card is
 * single-use UI: once chosen, the renderer disables the other options. Returns
 * the updated payload. Owner-scoping is the caller's responsibility (the route
 * loads the message via the owned conversation first).
 */
export async function setMessageChosen(
  db: DB,
  messageId: string,
  chosen: string,
): Promise<void> {
  const row = await db.query.messages.findFirst({ where: eq(messages.id, messageId) });
  if (!row) return;
  const payload = parsePayload<Record<string, unknown>>(row.payload);
  payload.chosen = chosen;
  await db.update(messages).set({ payload: JSON.stringify(payload) }).where(eq(messages.id, messageId));
}

/**
 * Parse a stored message `payload` defensively. `payload` is a free `text`
 * column; a malformed/non-JSON value (DB corruption, hand-edit, or a future
 * writer) must NOT abort the whole thread export — markdown-as-source-of-truth
 * is wedge-critical, so one bad row degrades to `{}` (an empty line) rather
 * than throwing out of the serializer. Flagged Cluster-1 /code-review 2026-06-05.
 */
export function parsePayload<T extends Record<string, unknown>>(payload: string | null): T {
  if (!payload) return {} as T;
  try {
    return JSON.parse(payload) as T;
  } catch {
    return {} as T;
  }
}

export async function serializeThreadMarkdown(
  db: DB,
  conversationId: string,
): Promise<string> {
  const rows = await getThread(db, conversationId);
  const lines: string[] = [];
  for (const m of rows) {
    if (m.kind === 'text') {
      lines.push(`### ${m.role === 'user' ? 'User' : 'Operator'}\n\n${m.body}\n`);
    } else if (m.kind === 'tool_step') {
      const p = parsePayload<{ tool?: string; summary?: string; status?: string }>(m.payload);
      lines.push(`- \`${p.tool ?? ''}\` — ${p.summary ?? ''} (${p.status ?? ''})`);
    } else if (m.kind === 'component') {
      const p = parsePayload<{
        type?: string;
        title?: string;
        prompt?: string;
        chosen?: string;
      }>(m.payload);
      if (p.type === 'link_panel') {
        lines.push(`- [link: ${p.title ?? ''}]`);
      } else if (p.type === 'choice_card') {
        lines.push(`- Q: ${p.prompt ?? ''}${p.chosen ? ` → ${p.chosen}` : ''}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Operator cockpit chat (Task 8) — boot recovery for interrupted turns (M12).
 *
 * THE Cluster-3 review gap: a conversation run has NO `agent_run` row (it is the
 * walled-off, ephemeral-token path), so the runner's existing orphaned-run boot
 * recovery (recoverOrphanRuns) can NEVER clear a dangling `conversations.active_run_id`.
 * After a restart, EVERY in-memory conversation run is gone, so ANY surviving
 * `active_run_id` is by definition orphaned (same self-healing argument as the
 * orphan-token sweep). This sweep:
 *   1. clears every non-null `active_run_id` (unwedges the composer), AND
 *   2. for each cleared conversation, appends a terminal `text` message
 *      summarizing the persisted `tool_step` rows from the interrupted run — so a
 *      crash mid act-then-report never leaves the human blind to what was applied
 *      (the tool_step rows ARE the audit trail; this surfaces them).
 *
 * Plain `db`, no events (Inv 5 deliberate exception — same as the rest of this
 * file). Idempotent + cheap; safe to run on every boot. Returns the count of
 * conversations recovered (for logging/tests).
 */
export async function recoverInterruptedConversations(db: DB): Promise<number> {
  const stale = await db.query.conversations.findMany({
    where: (c, { isNotNull }) => isNotNull(c.activeRunId),
  });
  let recovered = 0;
  for (const conv of stale) {
    // Cluster-4 /code-review fix: each conversation is recovered INDEPENDENTLY
    // (per-conv try/catch) so one malformed conversation can't abort the whole
    // sweep and leave later conversations wedged. The slot-clear is the
    // load-bearing unwedge; the summary is best-effort. We clear the slot LAST
    // and only after a successful summary append — BUT if the summary throws, we
    // STILL clear the slot in the catch (unwedging beats a perfect summary). The
    // clear is idempotent (already-null rows aren't re-swept), so a re-sweep after
    // a crash between append+clear at worst appends one duplicate summary — never
    // a permanent wedge.
    try {
      // Summarize the tool steps the interrupted run persisted. Match by the run
      // id the conversation was holding so the summary reflects THAT turn only.
      const stepRows = await db.query.messages.findMany({
        where: and(eq(messages.conversationId, conv.id), eq(messages.runId, conv.activeRunId!)),
        orderBy: (m, { asc }) => [asc(m.seq)],
      });
      const completed = stepRows
        .filter((m) => m.kind === 'tool_step')
        .map((m) => {
          const p = parsePayload<{ tool?: string; status?: string }>(m.payload);
          return `${p.tool ?? 'tool'} (${p.status ?? 'unknown'})`;
        })
        .join(', ');
      const body =
        completed.length > 0
          ? `The previous turn was interrupted. Completed: ${completed}.`
          : 'The previous turn was interrupted before any tools ran.';
      await appendMessage(db, { conversationId: conv.id, role: 'operator', kind: 'text', body });
      await db.update(conversations).set({ activeRunId: null }).where(eq(conversations.id, conv.id));
      recovered += 1;
    } catch (err) {
      // The summary failed — still UNWEDGE the conversation (the composer must not
      // stay locked). Without this, a single bad conversation wedges forever.
      console.error(`[recovery] conversation ${conv.id} summary failed; clearing slot anyway`, err);
      await db
        .update(conversations)
        .set({ activeRunId: null })
        .where(eq(conversations.id, conv.id))
        .catch(() => {});
    }
  }
  return recovered;
}
