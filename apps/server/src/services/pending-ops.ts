/**
 * Operator cockpit chat (Task 7) — the irreversible-op confirm gate's durable
 * state: the `pending_ops` table.
 *
 * This is the SERVER-RECORDED side of the hard gate (spec: Irreversible-op gate §;
 * threat model M4–M7, M13). A HIGH-tier tool call inside a conversation does NOT
 * apply — `executeTool` records a `pending_ops` row {op, params, target, caller,
 * conversation} and surfaces a `choice_card`; only on a single-use, caller-bound,
 * non-expired confirmation does the destructive handler run, and it runs the
 * RECORDED params — never the operator's turn-2 re-interpretation. That recorded-
 * params execution is what makes confirm injection-proof (M6).
 *
 * Inv 5 DELIBERATE EXCEPTION: like conversations/messages, `pending_ops` is
 * walled off from the event stream. It is transient gate state, not a document
 * and not agent-reactable, so it uses plain `db` transactions and emits NO events.
 * (Same ratified exception as conversations.ts.)
 *
 * PARAMS MATCHING (M6 — injection-proof by construction). Params are stored as
 * `JSON.stringify(<the Zod-parsed args>)` at record time and matched by EXACT
 * string equality of `JSON.stringify(<the Zod-parsed args>)` at confirm time. Both
 * sides parse the SAME `def.schema`, so the serialization is deterministic for the
 * same logical args. A turn-2 re-read that produces a different arg shape yields a
 * different string → NO match → the gate refuses (fail-closed: an unmatched op is
 * re-proposed, never silently executed with drifted params).
 */

import { and, eq, inArray, lt, or } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { type PendingOp, pendingOps } from '../db/schema.ts';
import { env } from '../env.ts';

type DBOrTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

/** Default confirmation TTL: a pending op a human hasn't confirmed within this
 *  window is stale (expired). 5 minutes — long enough for a human to read the
 *  card and click, short enough that a stale confirmation can't be replayed days
 *  later. (M7 — expiring confirmations.) */
export const PENDING_OP_TTL_MS = 5 * 60 * 1000;

/**
 * Canonical params serialization. The ONE place params become a comparable
 * string — used at record AND at match so the two never diverge (M6). Callers
 * pass the Zod-PARSED args (deterministic shape); this stringifies them verbatim.
 */
export function serializePendingParams(parsedArgs: unknown): string {
  return JSON.stringify(parsedArgs ?? null);
}

/**
 * Record a pending (unconfirmed) op. status='pending', expires_at = now + TTL.
 * Returns the inserted row (the `choice_card`'s "yes" option carries `row.id`).
 */
export async function recordPendingOp(
  db: DBOrTx,
  input: {
    conversationId: string;
    callerId: string;
    op: string;
    /** The Zod-PARSED args — serialized verbatim, immutable once stored (M6). */
    params: unknown;
    target: string;
  },
): Promise<PendingOp> {
  const now = Date.now();
  const row = {
    id: crypto.randomUUID(),
    conversationId: input.conversationId,
    callerId: input.callerId,
    op: input.op,
    params: serializePendingParams(input.params),
    target: input.target,
    status: 'pending' as const,
    createdAt: new Date(now),
    expiresAt: new Date(now + PENDING_OP_TTL_MS),
    executedAt: null,
    executedBy: null,
  };
  await db.insert(pendingOps).values(row);
  return row as PendingOp;
}

/**
 * Find a CONFIRMED, non-expired pending op matching this exact action
 * (conversation + op + serialized params, M6). Returns undefined if none — which
 * is the gate's REFUSE signal. An expired confirmation never matches (M7).
 */
export async function getConfirmedPendingOp(
  db: DBOrTx,
  input: { conversationId: string; op: string; params: unknown },
): Promise<PendingOp | undefined> {
  const wanted = serializePendingParams(input.params);
  const rows = await db
    .select()
    .from(pendingOps)
    .where(
      and(
        eq(pendingOps.conversationId, input.conversationId),
        eq(pendingOps.op, input.op),
        eq(pendingOps.status, 'confirmed'),
      ),
    );
  const now = Date.now();
  return rows.find((r) => r.params === wanted && r.expiresAt.getTime() > now);
}

/**
 * Single-use, caller-bound, expiry-checked confirm (M7). Atomically flips
 * pending→confirmed ONLY when:
 *   - the row id matches, AND
 *   - the row is still 'pending', AND
 *   - the confirming user equals the row's caller_id (caller-bound).
 * Atomicity: `UPDATE … WHERE id AND caller_id AND status='pending'` then assert
 * exactly one row changed — so a replay (status already moved off 'pending'), a
 * foreign-user confirm (caller_id mismatch), or a missing row all change ZERO
 * rows and are rejected. Expiry is checked separately (an expired pending op
 * cannot be confirmed; we mark it expired and reject).
 */
export async function confirmPendingOp(
  db: DBOrTx,
  id: string,
  callerId: string,
): Promise<PendingOp> {
  // Load the row caller-bound first so a foreign-user confirm cannot even learn
  // the row exists, and an expired row is reported as expired (not generic).
  const existing = await db
    .select()
    .from(pendingOps)
    .where(and(eq(pendingOps.id, id), eq(pendingOps.callerId, callerId)))
    .then((r) => r[0]);
  if (!existing) {
    throw new Error('PENDING_OP_NOT_FOUND');
  }
  if (existing.status !== 'pending') {
    // Replay / already-confirmed / already-rejected — single-use violated.
    throw new Error('PENDING_OP_NOT_CONFIRMABLE');
  }
  if (existing.expiresAt.getTime() <= Date.now()) {
    // Expired — flip to 'expired' so it can never be confirmed later, then reject.
    await db
      .update(pendingOps)
      .set({ status: 'expired' })
      .where(and(eq(pendingOps.id, id), eq(pendingOps.status, 'pending')));
    throw new Error('PENDING_OP_EXPIRED');
  }

  // Atomic single-use flip: pending→confirmed, caller-bound. changes===1 ⇒ won.
  const res = db
    .update(pendingOps)
    .set({ status: 'confirmed' })
    .where(
      and(
        eq(pendingOps.id, id),
        eq(pendingOps.callerId, callerId),
        eq(pendingOps.status, 'pending'),
      ),
    )
    .run() as unknown as { changes: number };
  if (res.changes !== 1) {
    // Lost a concurrent confirm/expire race between the read above and here.
    throw new Error('PENDING_OP_NOT_CONFIRMABLE');
  }
  const confirmed = await db
    .select()
    .from(pendingOps)
    .where(eq(pendingOps.id, id))
    .then((r) => r[0]);
  return confirmed as PendingOp;
}

/**
 * Mark a confirmed op EXECUTED after its handler succeeds (audit trail, #5).
 * Flips confirmed→executed, stamps executed_at/executed_by. `params` stays
 * immutable — this is the durable "what destructive op ran, with what params,
 * confirmed by whom, when" record for the support path. Idempotent-safe: only a
 * row still 'confirmed' is advanced.
 */
export async function markExecuted(
  db: DBOrTx,
  id: string,
  executedBy: string,
): Promise<void> {
  await db
    .update(pendingOps)
    .set({ status: 'executed', executedAt: new Date(), executedBy })
    .where(and(eq(pendingOps.id, id), eq(pendingOps.status, 'confirmed')));
}

export const PENDING_OPS_RETENTION_MS = env.FOLIO_PENDING_OPS_RETENTION_MS;

/**
 * Disk-hygiene reaper for `pending_ops`. Rows are status-flipped, never deleted by
 * the gate (schema), so the table only grows. This deletes rows that can no longer
 * be live, after a generous retention window that preserves the executed-op audit
 * trail. SAFETY (invariant 12): NEVER deletes a `confirmed` row (recorded params
 * about to be replayed) and NEVER a `pending` row whose TTL hasn't long expired (a
 * confirm-card may be showing). Atomic single DELETE — no SELECT-then-DELETE TOCTOU.
 *
 * @param at injectable "now" for deterministic tests; defaults to Date.now().
 * @returns number of rows reaped.
 */
export async function reapStalePendingOps(db: DBOrTx, at: number = Date.now()): Promise<number> {
  const cutoff = new Date(at - PENDING_OPS_RETENTION_MS);
  const reaped = await db
    .delete(pendingOps)
    .where(
      or(
        and(
          inArray(pendingOps.status, ['executed', 'rejected', 'expired']),
          lt(pendingOps.createdAt, cutoff),
        ),
        and(eq(pendingOps.status, 'pending'), lt(pendingOps.expiresAt, cutoff)),
      ),
    )
    .returning({ id: pendingOps.id });
  return reaped.length;
}

/** Mark a pending/confirmed op rejected (a "no"/cancel click). */
export async function rejectPendingOp(db: DBOrTx, id: string, callerId: string): Promise<void> {
  await db
    .update(pendingOps)
    .set({ status: 'rejected' })
    .where(
      and(
        eq(pendingOps.id, id),
        eq(pendingOps.callerId, callerId),
        // Only a not-yet-executed op can be rejected.
        eq(pendingOps.status, 'pending'),
      ),
    );
}
