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
 *  - On first registration the cursor seeds at MAX(seq) so a reactor starts
 *    "from now" and never replays history.
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

import { asc, eq, gt } from 'drizzle-orm';
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

async function loadOrSeedCursor(db: DB, reactorId: string): Promise<number> {
  const row = await db.query.reactorCursors.findFirst({
    where: eq(reactorCursors.reactorId, reactorId),
  });
  if (row) return row.lastSeq;
  // F-4 shake-out fix — seed at 0, NOT MAX(seq).
  //
  // The C.3 spec seeded a brand-new reactor's cursor at MAX(events.seq)
  // ("start from now") to avoid a newly-added reactor stampeding on long-closed
  // history. But `loadOrSeedCursor` runs LAZILY on the dispatcher's FIRST TICK
  // (~1s after boot), which RACES the events written during startup: on a fresh
  // instance, an `agent.task.assigned` written before that first tick lands
  // BELOW the seeded MAX(seq), so the matcher treats it as "already seen" and
  // SILENTLY never creates the run. (Reproduced: cursor seeded at the
  // assignment's own seq, 0 runs created — F-4 e2e + diagnose-http-chain.ts.)
  // Seeding at 0 makes a first-registration reactor process the FULL log, which
  // is safe: the matcher is idempotent (getActiveRun no-ops replays) and
  // kind-filtered (it ignores document.created/etc.), and V1 has exactly one
  // reactor seeded at first boot — so there is no "stampede on a long-lived
  // instance" case to protect against. If a genuinely-new reactor type is added
  // to an existing instance later, give IT an explicit seed-at-MAX at
  // registration; do not re-introduce the boot race here.
  await db.insert(reactorCursors).values({ reactorId, lastSeq: 0, updatedAt: new Date() });
  return 0;
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
  const handle = setInterval(() => {
    if (running) return;
    running = true;
    void runDispatcherOnce(db, REACTORS)
      .catch((err) => console.error('[dispatcher] tick error', err))
      .finally(() => {
        running = false;
      });
  }, env.FOLIO_DISPATCHER_INTERVAL_MS);
  return () => clearInterval(handle);
}
