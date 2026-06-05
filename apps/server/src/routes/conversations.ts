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
  getThread,
  serializeThreadMarkdown,
} from '../services/conversations.ts';

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
