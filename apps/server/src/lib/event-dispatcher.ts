/**
 * Reaction Plane (Phase 3 C-10b) — durable, at-least-once event dispatcher.
 *
 * The second delivery plane over the append-only `events` table. (The first is
 * the in-memory `eventBus` — the lossy "Observation Plane" backing SSE.) This
 * dispatcher polls `events` by `seq` and fans each one out to registered
 * reactors via per-reactor cursors in `reactor_cursors`.
 *
 * Delivery contract:
 *  - Each reactor's cursor advances ONLY after a successful `react()`
 *    (cursor-after / at-least-once). A crash between the side-effect and the
 *    cursor-write replays the event next tick — reactors MUST be idempotent.
 *  - A throwing `react()` HALTS that reactor's drain this tick (cursor
 *    unchanged → the same event is retried next tick) and is NEVER allowed to
 *    roll back the originating write (mitigation 49). Other reactors are
 *    unaffected.
 *  - The cursor seeds at MAX(seq) EAGERLY at boot (seedReactorCursors, before
 *    traffic) so a reactor starts "from now", never replays history, and
 *    doesn't race startup writes (F-4/F-6).
 *  - Events whose kind the reactor doesn't subscribe to still advance the
 *    cursor (seen-and-skipped) so a narrow reactor never lags forever.
 *
 * Health: a per-reactor in-memory `halted` set drives edge-triggered
 * `reactor.halted` / `reactor.recovered` signals. These are LIVE-ONLY bus
 * publishes (not durable `events` rows, not replayed over SSE on reconnect):
 * `events.workspace_id` is a NOT NULL FK, so a `workspaceId: null` system event
 * cannot persist. The durable truth for reactor health is cursor-lag
 * (`MAX(seq) − last_seq`), re-derivable any time; a missed live `reactor.halted`
 * self-heals because the next failed tick re-fires it (spec §4b).
 */

import { asc, eq, gt, sql } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { events, reactorCursors } from '../db/schema.ts';
import { env } from '../env.ts';
import { type BusEvent, eventBus } from './event-bus.ts';
import { REACTORS } from './reactors.ts';

export interface Reactor {
  id: string;
  kinds: readonly string[];
  react(event: BusEvent & { seq: number }): Promise<void>;
}

// In-memory per-reactor health (healthy | halted). Reset on restart; re-derived
// from the next tick's outcome. Cursor-lag is the durable truth — see §4b.
const halted = new Set<string>();

/**
 * Report reactor health onto the in-memory bus. System events are LIVE signals,
 * not durable rows: `events.workspace_id` is a NOT NULL FK, so a
 * `workspaceId: null` event can't persist. Publish to the bus only (live-only —
 * NOT inserted into `events`, NOT replayed over SSE on reconnect). The durable
 * truth is cursor-lag (spec §4b). `createdAt` set explicitly.
 *
 * `workspaceId`, `projectId`, AND `documentId` are all set null so the event
 * transcends EVERY scope. The bus only short-circuits the projectId filter on
 * `projectId === null` (the BUG-021 precedent); leaving projectId `undefined`
 * would let a `?project=X` SSE subscriber's project gate DROP the health
 * signal. Null at every layer keeps a project-scoped operator able to see
 * reactor.halted / reactor.recovered.
 */
function emitReactorHealth(
  kind: 'reactor.halted' | 'reactor.recovered',
  payload: Record<string, unknown>,
): void {
  eventBus.publish({
    workspaceId: null,
    projectId: null,
    documentId: null,
    kind,
    actor: 'system:dispatcher',
    payload,
    createdAt: Date.now(),
  });
}

/**
 * Eagerly seed any not-yet-registered reactor's cursor at `MAX(events.seq)`
 * ("start from now"), to be called ONCE at server boot BEFORE traffic is served
 * (see index.ts). This is the fix for the F-4/F-6 cursor-seed bug, and it
 * resolves BOTH failure modes the shake-out surfaced:
 *
 *   - F-4 (seed lazily on first tick): the dispatcher's first tick ran ~1s
 *     after boot, racing events written during startup — an assignment written
 *     before the seed landed below MAX(seq) and was silently dropped. Seeding
 *     EAGERLY at boot (before any request can write an event) closes that race.
 *   - F-6 (seed at 0): seeding a brand-new reactor at 0 made it REPLAY the
 *     entire append-only event log on an existing instance's first upgrade
 *     boot — re-matching every historical assignment whose run already
 *     COMPLETED (getActiveRun only no-ops *active* peers, not closed ones) →
 *     a stampede of billed re-runs on long-closed tasks.
 *
 * Eager + seed-at-MAX is correct under both: the cursor exists before the first
 * event of this process is written (no race), AND it starts "from now" (no
 * historical replay). `onConflictDoNothing` makes it idempotent across reboots
 * and any concurrent first-call.
 */
export async function seedReactorCursors(db: DB, reactors: readonly Reactor[]): Promise<void> {
  const [{ max } = { max: 0 }] = await db
    .select({ max: sql<number>`COALESCE(MAX(${events.seq}), 0)` })
    .from(events);
  const seed = max ?? 0;
  for (const r of reactors) {
    await db
      .insert(reactorCursors)
      .values({ reactorId: r.id, lastSeq: seed, updatedAt: new Date() })
      .onConflictDoNothing();
  }
}

async function loadOrSeedCursor(db: DB, reactorId: string): Promise<number> {
  const row = await db.query.reactorCursors.findFirst({
    where: eq(reactorCursors.reactorId, reactorId),
  });
  if (row) return row.lastSeq;
  // Fallback seed for a reactor whose cursor was NOT eagerly seeded at boot
  // (e.g. a test calling runDispatcherOnce directly, or a reactor registered
  // after startup). Seed at MAX(seq) — NEVER 0 — so a late registration on an
  // existing instance does not replay the whole historical log (the F-6
  // stampede). The boot race is closed by seedReactorCursors() at startup
  // (index.ts); this lazy path must stay seed-at-MAX to preserve the
  // "start from now" property. onConflictDoNothing guards a concurrent insert.
  const [{ max } = { max: 0 }] = await db
    .select({ max: sql<number>`COALESCE(MAX(${events.seq}), 0)` })
    .from(events);
  const seed = max ?? 0;
  await db
    .insert(reactorCursors)
    .values({ reactorId, lastSeq: seed, updatedAt: new Date() })
    .onConflictDoNothing();
  return seed;
}

async function persistCursor(db: DB, reactorId: string, seq: number): Promise<void> {
  await db
    .update(reactorCursors)
    .set({ lastSeq: seq, updatedAt: new Date() })
    .where(eq(reactorCursors.reactorId, reactorId));
}

/** One dispatch tick across all reactors. Exported for tests. */
export async function runDispatcherOnce(db: DB, reactors: readonly Reactor[]): Promise<void> {
  for (const r of reactors) {
    let cursor = await loadOrSeedCursor(db, r.id);
    const rows = await db.query.events.findMany({
      where: gt(events.seq, cursor),
      orderBy: asc(events.seq),
      limit: env.FOLIO_DISPATCHER_BATCH,
    });
    for (const row of rows) {
      const ev: BusEvent & { seq: number } = {
        id: row.id,
        workspaceId: row.workspaceId,
        projectId: row.projectId,
        documentId: row.documentId,
        kind: row.kind as BusEvent['kind'],
        actor: row.actor ?? undefined,
        payload: row.payload,
        createdAt: row.createdAt.getTime(),
        seq: row.seq,
      };
      if (!r.kinds.includes(row.kind)) {
        cursor = row.seq;
        await persistCursor(db, r.id, cursor); // seen-and-skipped; advance past it
        continue;
      }
      try {
        await r.react(ev);
        cursor = row.seq;
        await persistCursor(db, r.id, cursor); // cursor-after: advance only on success
        if (halted.has(r.id)) {
          halted.delete(r.id);
          emitReactorHealth('reactor.recovered', { reactor_id: r.id });
        }
      } catch (err) {
        console.error(`[dispatcher] reactor ${r.id} halted at seq ${row.seq}`, err);
        if (!halted.has(r.id)) {
          halted.add(r.id);
          // Mitigation 53 — reactor.halted is a workspaceId:null system event
          // broadcast to EVERY subscriber across ALL tenants. A reactor's
          // thrown Error.message can carry tenant data (a document title in an
          // error string). Broadcast only the error CLASS name, never the
          // message; the full message stays in the server-side console.error
          // above.
          emitReactorHealth('reactor.halted', {
            reactor_id: r.id,
            stuck_at_seq: row.seq,
            error_summary: err instanceof Error ? err.name : 'unknown',
          });
        }
        break; // halt this reactor's drain this tick; cursor unchanged → retry next tick
      }
    }
  }
}

/**
 * Start the interval-driven dispatcher loop. Returns a stop function that
 * clears the timer. Each tick runs `runDispatcherOnce` over the registered
 * reactors; a thrown tick is logged and swallowed so one bad tick can't kill
 * the loop.
 */
export function startEventDispatcher(db: DB): () => void {
  // I2 (Phase-3 shake-out): re-entrancy latch. setInterval does NOT await the
  // async callback, so a tick that outruns the interval (slow react(), a full
  // 100-event batch) would overlap the next — two ticks racing the same
  // per-reactor cursor read-modify-write, turning at-least-once into
  // at-least-once-per-overlap. Skip a tick while the prior one is still running;
  // the next interval picks up where it left off.
  let running = false;

  // F-4/F-6 fix: seed every reactor's cursor at MAX(seq) EAGERLY, before the
  // first tick can run, so (a) the cursor exists before any request writes an
  // event (closes the boot race that silently dropped startup assignments) and
  // (b) a fresh-but-existing instance starts "from now" instead of replaying
  // its whole historical log (avoids the completed-task re-run stampede). We
  // hold the `running` latch until the seed resolves so no tick processes an
  // unseeded reactor; `onConflictDoNothing` makes reboots a no-op.
  running = true;
  const seeded = seedReactorCursors(db, REACTORS)
    .catch((err) => console.error('[dispatcher] cursor seed error', err))
    .finally(() => {
      running = false;
    });

  const handle = setInterval(() => {
    if (running) return;
    running = true;
    void seeded
      .then(() => runDispatcherOnce(db, REACTORS))
      .catch((err) => console.error('[dispatcher] tick error', err))
      .finally(() => {
        running = false;
      });
  }, env.FOLIO_DISPATCHER_INTERVAL_MS);
  return () => clearInterval(handle);
}
