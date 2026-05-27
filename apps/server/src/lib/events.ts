import { inArray, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { EventKind } from '@folio/shared';
import { events } from '../db/schema.ts';
import type { DB } from '../db/client.ts';
import { eventBus, type BusEvent } from './event-bus.ts';

// Phase 2.6 sub-phase D: EventKind moved to @folio/shared so the web UI can
// import it (TriggerForm needs the same union). Re-exported here for source
// compatibility with the many server callers that import EventKind from this
// module.
export type { EventKind };

export interface EmitArgs {
  workspaceId: string;
  /** null for workspace-scoped resources (agent/trigger); a project id otherwise. */
  projectId?: string | null;
  documentId?: string;
  kind: EventKind;
  actor: string;
  payload?: unknown;
}

// Drizzle transaction handles share the query API with DB; one shape works for both.
type DBOrTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

/**
 * F6 — per-transaction publish queue.
 *
 * `eventBus.publish` used to run synchronously inside `emitEvent`, while the
 * caller's `db.transaction(...)` was still open. If the transaction later
 * rolled back, SSE subscribers had already been told about an event that
 * never persisted — Last-Event-Id replay couldn't redeliver the id, so
 * clients diverged from server state.
 *
 * The fix: when `emitEvent` is called with a transaction handle that has
 * been registered via `txWithEvents`, the bus publish is queued on that
 * tx's pending list and drained ONLY after the transaction commits. If the
 * transaction throws (rollback), the queue is discarded.
 *
 * Callers that pass `db` directly (no surrounding transaction — only test
 * code in events.test.ts does this) keep the legacy behavior: publish
 * inline. That path can't roll back, so it stays safe.
 */
/**
 * S16: rollback scrub observability hook. Operators wiring up alerting
 * (Sentry/PagerDuty/etc.) can register a listener here and get notified
 * when the bun-sqlite phantom-rollback safety net fails — meaning the
 * durable event log and the live SSE bus have diverged on a real workspace.
 *
 * The hook is best-effort: a thrown listener is swallowed (logging is not
 * itself the place to crash the process). Tests use this to assert the
 * scrub failure signaled, instead of relying on console.error capture.
 */
export type ScrubFailure = {
  originalError: string;
  scrubError: string;
  affectedIdsBatch: readonly string[];
};
type ScrubListener = (failure: ScrubFailure) => void;
const scrubListeners = new Set<ScrubListener>();
export function onRollbackScrubFailure(listener: ScrubListener): () => void {
  scrubListeners.add(listener);
  return () => scrubListeners.delete(listener);
}

const pendingByTx = new WeakMap<object, BusEvent[]>();

// S15: per-tx seq counter. The previous `MAX(seq)+1` SELECT per emit was
// O(N) round-trips for a tx that fires N events (e.g. seedBuiltinTriggers
// emits 4 in one go). The first emit primes the counter from MAX(seq);
// subsequent emits in the SAME tx increment in-memory. The
// events_seq_idx UNIQUE index still guards against any caller that
// forgets to use the helper.
const seqCounterByTx = new WeakMap<object, number>();

export async function emitEvent(tx: DBOrTx, args: EmitArgs): Promise<void> {
  const id = nanoid();
  const createdAt = Date.now();
  // H3: allocate the next monotonic seq inside the writer's tx. SQLite's
  // exclusive write lock serializes MAX(seq) + insert, so two concurrent
  // emitEvent calls in separate transactions get distinct, monotonic seq
  // values. The events_seq_idx UNIQUE index protects against any regression
  // that ever forgets to set seq — the insert would fail loudly.
  const txKey = tx as object;
  let seq: number;
  const cached = seqCounterByTx.get(txKey);
  if (cached !== undefined) {
    seq = cached + 1;
  } else {
    const [{ max: maxSeq } = { max: 0 }] = await tx
      .select({ max: sql<number>`COALESCE(MAX(${events.seq}), 0)` })
      .from(events);
    seq = (maxSeq ?? 0) + 1;
  }
  seqCounterByTx.set(txKey, seq);
  await tx.insert(events).values({
    id,
    workspaceId: args.workspaceId,
    projectId: args.projectId ?? null,
    documentId: args.documentId ?? null,
    kind: args.kind,
    actor: args.actor,
    payload: (args.payload ?? {}) as unknown,
    // Explicit createdAt so the DB row and the bus event share one value —
    // SQL-default `unixepoch() * 1000` would fire later and drift sub-ms,
    // which could put Task 4's Last-Event-Id replay out of order with live
    // events on a busy server.
    createdAt: new Date(createdAt),
    seq,
  });

  const busEvent: BusEvent = {
    id,
    workspaceId: args.workspaceId,
    projectId: args.projectId ?? null,
    documentId: args.documentId ?? null,
    kind: args.kind,
    actor: args.actor,
    payload: args.payload ?? {},
    createdAt,
  };

  // If the caller wrapped this tx with txWithEvents, defer the publish to
  // after commit. Otherwise (tests using `db` directly) publish inline.
  const pending = pendingByTx.get(tx as object);
  if (pending) {
    pending.push(busEvent);
  } else {
    eventBus.publish(busEvent);
  }
}

/**
 * Wrap `db.transaction(fn)` so any `emitEvent(tx, ...)` calls inside `fn`
 * have their bus publish deferred until AFTER the transaction commits.
 *
 * Drop-in replacement: callers swap `await db.transaction(async (tx) => ...)`
 * for `await txWithEvents(db, async (tx) => ...)`. Everything else is the same.
 *
 * On rollback (anything thrown by `fn`), pending events are discarded — no
 * phantom events ever reach subscribers.
 */
export async function txWithEvents<T>(
  db: DB,
  fn: (tx: Parameters<Parameters<DB['transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  const pending: BusEvent[] = [];
  try {
    const result = await db.transaction(async (tx) => {
      pendingByTx.set(tx as object, pending);
      return fn(tx);
    });
    // Tx committed — drain the queue onto the in-process bus.
    for (const e of pending) eventBus.publish(e);
    return result;
  } catch (err) {
    // Tx rolled back — bus publish suppressed.
    //
    // G10: bun-sqlite + drizzle has a documented quirk where async throws
    // inside db.transaction don't actually roll back the SQL row. That
    // leaves an `events` row in the durable log without a matching live
    // bus publish — live SSE subscribers miss it, but Last-Event-Id replay
    // later delivers it, making the two paths disagree. Defensively scrub
    // the rows we intended to roll back.
    //
    // H10: chunk the DELETE to stay under SQLite's max-variable cap.
    // bun-sqlite ships SQLite ≥ 3.42 with default 32766, but a fixed
    // batch size keeps us robust against older builds AND any future
    // bulk-emit path (Phase 3 reconciler at scale, mass import). Also:
    // surface scrub failures to console so the divergence between the
    // durable log and the live bus is OPERATOR-visible instead of silent.
    if (pending.length > 0) {
      const ids = pending.map((e) => e.id).filter((id): id is string => typeof id === 'string');
      const CHUNK = 500;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const batch = ids.slice(i, i + CHUNK);
        try {
          await db.delete(events).where(inArray(events.id, batch));
        } catch (scrubErr) {
          // Original error always re-thrown below. Log the scrub failure
          // so the resulting durable-vs-bus divergence is detectable.
          const failure: ScrubFailure = {
            originalError: err instanceof Error ? err.message : String(err),
            scrubError: scrubErr instanceof Error ? scrubErr.message : String(scrubErr),
            affectedIdsBatch: batch,
          };
          console.error(
            '[events] rollback-scrub failed; events row(s) may persist without matching bus publish',
            failure,
          );
          // S16: notify operator-registered listeners. Best-effort: a
          // throwing listener can't be allowed to suppress the original
          // `throw err` below.
          for (const listener of scrubListeners) {
            try { listener(failure); } catch { /* listener swallowed */ }
          }
        }
      }
    }
    throw err;
  }
}
