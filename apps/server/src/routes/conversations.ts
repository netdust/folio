/**
 * Operator cockpit chat (Task 6) — conversation REST surface.
 *
 * SESSION-ONLY (invariant 4): the cockpit is a human surface; a bearer token does
 * NOT drive it. Mounted on v1 (NOT wScope) where `attachToken` does not run, so a
 * Bearer is never parsed here — `requireSessionUser` is the operative gate.
 *
 * OWNER-SCOPED reads (M11): EVERY conversation read/write filters
 * `conversations.created_by === sessionUser.id`. A foreign user gets 404 (not 403
 * — the existence of another user's conversation is not disclosed).
 *
 * SINGLE-ACTIVE-TURN CAS (M14): a turn starts ONLY by atomically acquiring the
 * conversation's run slot —
 *   UPDATE conversations SET active_run_id = :newRunId
 *    WHERE id = :id AND active_run_id IS NULL
 * — and verifying exactly one row changed. The loser of a double-send is rejected
 * 409 OPERATOR_BUSY, NOT queued, NOT run. On ANY failure between acquire and the
 * runner kick the slot is RELEASED so the conversation isn't wedged.
 */

import { zValidator } from '@hono/zod-validator';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/client.ts';
import { conversations } from '../db/schema.ts';
import { HTTPError, jsonOk } from '../lib/http.ts';
import { runAgent as realRunAgent } from '../lib/runner.ts';
import { type AuthContext, getUser, requireSessionUser } from '../middleware/auth.ts';
import { OPERATOR_SLUG } from '../lib/operator.ts';
import { createConversationRun } from '../services/conversation-runs.ts';
import {
  appendMessage,
  createConversation,
  getMessage,
  getThread,
  parsePayload,
  serializeThreadMarkdown,
  setMessageChosen,
} from '../services/conversations.ts';
import { confirmPendingOp, rejectPendingOp } from '../services/pending-ops.ts';

/**
 * The runner kick — fire-and-forget like the poller's `void run(...).catch(...)`.
 * Indirected through a module-level binding so route tests can substitute a
 * counting stub WITHOUT executing a real provider. Production uses `realRunAgent`.
 */
let kickRunAgent: (args: { runId: string }) => Promise<void> = realRunAgent;

/** Test-only: swap the runner kick. Throws in production (mirrors the runner's
 *  `__setCcSpawnForTest` hatch). */
export function __setRunAgentForTest(
  fn: ((args: { runId: string }) => Promise<void>) | undefined,
): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__setRunAgentForTest is test-only and must not be called in production');
  }
  kickRunAgent = fn ?? realRunAgent;
}

const conversationsRoute = new Hono<AuthContext>();

// Session-only across the board (no bearers — invariant 4).
conversationsRoute.use('*', requireSessionUser);

/**
 * Load a conversation that the session user OWNS, or throw 404. The single
 * owner-scoping convergence point (M11) — every handler routes its existence +
 * authorization decision through this so the `created_by` predicate can't be
 * forgotten on one route.
 */
async function loadOwnedConversation(userId: string, id: string) {
  const conv = await db.query.conversations.findFirst({
    where: and(eq(conversations.id, id), eq(conversations.createdBy, userId)),
  });
  if (!conv) {
    // 404, not 403 — do not disclose that another user's conversation exists.
    throw new HTTPError('CONVERSATION_NOT_FOUND', 'conversation not found', 404);
  }
  return conv;
}

/**
 * Acquire the single-active-turn slot atomically (M14), append the user message,
 * build the run, and kick the runner. Returns the run id.
 *
 * ORDERING (CAS BEFORE the user-message append). The CAS is the FIRST thing the
 * turn does so the LOSER of a double-send does nothing at all — not even an
 * append. This is load-bearing: `messages.seq` is allocated `MAX(seq)+1` under a
 * UNIQUE(conversation_id, seq) index, so two concurrent appends would BOTH
 * compute the same seq and the second would violate the unique index (a 500, not
 * a clean 409). Acquiring the slot first means only the winner ever appends, so
 * the seq allocator is never raced (threat model M14: "because only one run is
 * ever active, the max(seq)+1 allocator cannot race"). The winner's prompt is
 * persisted; the loser's text stays in the composer client-side on the 409.
 *
 * Shared by the typed-message path and the ordinary-choice-card path (a card
 * click that re-enters as a new turn) so the CAS + release logic lives once.
 */
async function startTurn(
  conv: { id: string; createdBy: string },
  userText: string,
): Promise<string> {
  const newRunId = nanoid();

  // ATOMIC compare-and-set: acquire the slot ONLY if it is free. `.run()` exposes
  // `changes`; exactly-1 means we won, 0 means a concurrent turn already holds it.
  // drizzle's bun-sqlite `.run()` returns `{ changes, lastInsertRowid }` at
  // runtime but is typed `void` on the shared DB type; cast to read `changes`.
  const res = db
    .update(conversations)
    .set({ activeRunId: newRunId })
    .where(and(eq(conversations.id, conv.id), isNull(conversations.activeRunId)))
    .run() as unknown as { changes: number };
  if (res.changes !== 1) {
    throw new HTTPError('OPERATOR_BUSY', 'The operator is already working on this conversation.', 409);
  }

  // Between acquire and kick, any failure must RELEASE the slot or the
  // conversation wedges until boot recovery (T8). Append + build run + kick inside
  // a try; release on throw.
  try {
    // The winner appends the user prompt (now race-free — it holds the slot).
    await appendMessage(db, {
      conversationId: conv.id,
      role: 'user',
      kind: 'text',
      body: userText,
    });
    await createConversationRun(db, {
      conversation: { id: conv.id, createdBy: conv.createdBy },
      runId: newRunId,
    });
    // Fire-and-forget (the human is waiting; the run streams into the thread). A
    // run rejection is swallowed + logged like the poller — never crash the
    // request. The run clears `active_run_id` on its own terminal path
    // (runAgent's conversation finally).
    void kickRunAgent({ runId: newRunId }).catch((err) => {
      console.error(`[conversations] run ${newRunId} rejected:`, err);
    });
  } catch (err) {
    await releaseSlot(conv.id, newRunId);
    throw err;
  }
  return newRunId;
}

/** Release the slot only if it still points at THIS run (compare-and-clear). */
async function releaseSlot(conversationId: string, runId: string): Promise<void> {
  await db
    .update(conversations)
    .set({ activeRunId: null })
    .where(and(eq(conversations.id, conversationId), eq(conversations.activeRunId, runId)));
}

// POST /conversations — create a conversation owned by the session user.
conversationsRoute.post(
  '/',
  zValidator('json', z.object({ title: z.string().min(1).max(200).optional() }).optional()),
  async (c) => {
    const user = getUser(c);
    const body = c.req.valid('json');
    const conv = await createConversation(db, {
      createdBy: user.id,
      operatorAgentId: OPERATOR_SLUG,
      title: body?.title ?? 'Untitled',
    });
    return jsonOk(c, { id: conv.id }, 201);
  },
);

// POST /conversations/:id/messages — append the user text, start a turn (M14 CAS).
conversationsRoute.post(
  '/:id/messages',
  zValidator('json', z.object({ text: z.string().min(1).max(10_000) })),
  async (c) => {
    const user = getUser(c);
    const id = c.req.param('id');
    const { text } = c.req.valid('json');

    const conv = await loadOwnedConversation(user.id, id);

    // Acquire the slot (M14) THEN append + kick — see startTurn for why the CAS
    // precedes the append (seq-allocator race). A loser double-send throws 409.
    const runId = await startTurn(conv, text);
    return jsonOk(c, { runId });
  },
);

// POST /conversations/:id/messages/:messageId/click — a choice_card button click.
//
// The click sends the chosen option ID (NEVER label text — the label is operator-
// authored and must not re-enter as trusted user input, M8). The server validates
// the id against the card's RECORDED options[].id set; an out-of-set id is rejected.
// Then ONE of three branches:
//   - CANCEL → reject any backing pending_op; no turn.
//   - CONFIRMATION card (the id IS a pending_ops.id, "yes") → confirmPendingOp
//     (single-use, caller-bound, M7), then start a turn so the operator re-issues
//     the action; executeTool finds the confirmed pending_op and executes the
//     RECORDED params (M6).
//   - ORDINARY card → start a NEW turn through the SAME run-creation path as a typed
//     message (re-fires the caller floor, M1; subject to the same M14 CAS).
conversationsRoute.post(
  '/:id/messages/:messageId/click',
  zValidator('json', z.object({ optionId: z.string().min(1) })),
  async (c) => {
    const user = getUser(c);
    const id = c.req.param('id');
    const messageId = c.req.param('messageId');
    const { optionId } = c.req.valid('json');

    const conv = await loadOwnedConversation(user.id, id);
    const msg = await getMessage(db, conv.id, messageId);
    if (!msg || msg.kind !== 'component') {
      throw new HTTPError('COMPONENT_NOT_FOUND', 'component not found', 404);
    }
    const payload = parsePayload<{
      type?: string;
      options?: { id: string; label: string }[];
      pending_op?: string;
      chosen?: string;
    }>(msg.payload);
    if (payload.type !== 'choice_card' || !Array.isArray(payload.options)) {
      throw new HTTPError('NOT_A_CHOICE_CARD', 'message is not a choice card', 400);
    }
    // Already chosen — single-use UI; reject a second click (idempotency + no
    // double-fire of a confirmation).
    if (typeof payload.chosen === 'string') {
      throw new HTTPError('ALREADY_CHOSEN', 'this card has already been answered', 409);
    }
    // M8 — validate the id against the PRESENTED set. Out-of-set → reject.
    const presented = new Set(payload.options.map((o) => o.id));
    if (!presented.has(optionId)) {
      throw new HTTPError('OPTION_NOT_IN_SET', 'option is not in the presented set', 400);
    }

    // Is this a confirmation card? A confirmation card carries `pending_op` (the
    // id of the recorded HIGH-tier op). The "yes" option's id EQUALS that
    // pending_op id; any other in-set id (e.g. 'cancel') is a "no".
    const isConfirmationCard = typeof payload.pending_op === 'string';
    const isConfirmYes = isConfirmationCard && optionId === payload.pending_op;
    const isCancel = optionId === 'cancel';

    // Lock the card to the chosen option (M8 — others disabled in the renderer).
    await setMessageChosen(db, messageId, optionId);

    if (isConfirmationCard && !isConfirmYes) {
      // A "no"/cancel on a confirmation card → reject the pending op; NO turn.
      await rejectPendingOp(db, payload.pending_op as string, user.id);
      return jsonOk(c, { confirmed: false });
    }

    if (isConfirmYes) {
      // Single-use, caller-bound confirm (M7). Throws on replay / foreign-user /
      // expiry — surface a clean 4xx rather than start a turn on a stale token.
      try {
        await confirmPendingOp(db, payload.pending_op as string, user.id);
      } catch (err) {
        const code = err instanceof Error ? err.message : 'PENDING_OP_NOT_CONFIRMABLE';
        const status = code === 'PENDING_OP_EXPIRED' ? 410 : 409;
        throw new HTTPError(code, 'this confirmation can no longer be applied', status);
      }
      // Start a turn so the operator re-issues the now-confirmed action; the gate
      // finds the confirmed pending_op and executes the RECORDED params (M6). The
      // turn also lets the operator REPORT the outcome (act-then-report).
      const runId = await startTurn(conv, 'Confirmed. Proceed with the action.');
      return jsonOk(c, { confirmed: true, runId });
    }

    if (isCancel) {
      // Cancel on an ORDINARY card → just lock it; no turn.
      return jsonOk(c, { confirmed: false });
    }

    // ORDINARY card → start a new turn reflecting the choice (re-fires the caller
    // floor + M14 CAS via startTurn). Send the option LABEL as context to the
    // operator, but the AUTHORITY decision is the id we validated above.
    const chosenOpt = payload.options.find((o) => o.id === optionId);
    const runId = await startTurn(conv, `I chose: ${chosenOpt?.label ?? optionId}`);
    return jsonOk(c, { runId });
  },
);

// GET /conversations/:id  AND  GET /conversations/:id.md
//
// Hono's RegExpRouter cannot reliably split an `:id` from a `.md` suffix on the
// SAME path segment (a default `:id` param greedily swallows `.md`, and a
// regex-constrained param fails to match the literal suffix). So ONE handler owns
// the segment and branches on the `.md` suffix itself — preserving the plan's
// exact `/conversations/:id.md` URL with a single, predictable route. (`.md` is
// not a legal nanoid/uuid suffix, so stripping it is unambiguous.)
conversationsRoute.get('/:id', async (c) => {
  const user = getUser(c);
  const raw = c.req.param('id');
  const isMarkdown = raw.endsWith('.md');
  const conversationId = isMarkdown ? raw.slice(0, -3) : raw;

  const conv = await loadOwnedConversation(user.id, conversationId);

  if (isMarkdown) {
    const md = await serializeThreadMarkdown(db, conv.id);
    c.header('Content-Type', 'text/markdown; charset=utf-8');
    return c.body(md);
  }

  const messages = await getThread(db, conv.id);
  return jsonOk(c, {
    id: conv.id,
    title: conv.title,
    activeRunId: conv.activeRunId,
    messages,
  });
});

export { conversationsRoute };
