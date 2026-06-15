/**
 * Retention reaper for the append-only `events` log (audit H7).
 *
 * The events table is append-only and only grows — emitEvent inserts, nothing
 * ever deletes. This reaper prunes rows that are BOTH older than the retention
 * window AND strictly below the minimum live reactor cursor, so an event any
 * reactor still needs is NEVER deleted and the SSE Last-Event-Id replay horizon
 * is preserved. Mirrors the `reapStalePendingOps` precedent: injectable `at`,
 * an atomic single DELETE (no SELECT-then-DELETE TOCTOU), returns the count.
 *
 * SAFETY (the cursor floor — invariant 8): `MIN(last_seq)` across all reactor
 * cursors is the live-replay floor. Only rows with `seq < minCursor` are
 * provably consumed by every reactor; rows at-or-above it may still be polled by
 * a lagging reactor or replayed to an SSE client via Last-Event-Id, so they are
 * never reaped. If NO reactor has committed a cursor yet, NOTHING is provably
 * dead — this returns 0 BY DESIGN (a naive age-only delete would wrongly reap
 * here, dropping events no reactor has had the chance to process).
 *
 * Inv 5 DELIBERATE EXCEPTION: this is a disk-hygiene DELETE, NOT a domain
 * mutation — it emits NO event. Calling emitEvent here would recurse the very
 * table it prunes (an event about pruning events). Same ratified exception shape
 * as `reapStalePendingOps` (transient/hygiene state, walled off from the event
 * stream).
 *
 * @param at injectable "now" for deterministic tests; defaults to Date.now().
 * @returns number of event rows reaped.
 */

import { and, lt } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { events } from '../db/schema.ts';
import { env } from '../env.ts';

// Local alias, mirroring pending-ops.ts (DBOrTx is NOT exported from db/client.ts).
type DBOrTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

export async function reapStaleEvents(db: DBOrTx, at: number = Date.now()): Promise<number> {
  const cutoff = new Date(at - env.FOLIO_EVENTS_RETENTION_MS);

  // The live-replay floor. With no committed cursor, nothing is provably dead.
  const cursors = await db.query.reactorCursors.findMany({ columns: { lastSeq: true } });
  if (cursors.length === 0) return 0;
  const minCursor = Math.min(...cursors.map((c) => c.lastSeq));

  // Atomic single DELETE: old AND strictly below the min cursor.
  //
  // SAFETY (TOCTOU): the cursor read above and this DELETE are NOT one transaction,
  // but that is provably safe ONLY because reactor cursors move FORWARD-ONLY (seeded
  // at MAX(seq), then advanced to strictly-higher seqs in event-dispatcher.ts; never
  // decremented or deleted). A concurrent reactor advance between read and DELETE can
  // only make this snapshot's minCursor STALER (lower) than reality → the DELETE is
  // strictly more conservative, never dropping a live row. If a future feature EVER
  // lowers/resets a cursor, this no-transaction assumption breaks — wrap both in a
  // single tx then.
  const reaped = await db
    .delete(events)
    .where(and(lt(events.createdAt, cutoff), lt(events.seq, minCursor)))
    .returning({ id: events.id });
  return reaped.length;
}
