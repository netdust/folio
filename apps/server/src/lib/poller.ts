/**
 * Phase 3 Sub-phase C.3 — Task C-12: the runner poller.
 *
 * The poller is the bridge from "run created" to "run executing". C-11 (the
 * trigger-matcher reactor) durably creates `planning` agent_run rows; this loop
 * CONSUMES them — it claims the oldest `planning` row, routes it by
 * `frontmatter.resume_of` to `runAgent` / `runAgentResume`, and dispatches it
 * fire-and-forget, bounded by a concurrency cap. On boot it recovers orphaned
 * `running` rows once.
 *
 * The dispatcher (events → create runs, C-10b) and this poller (claim planning
 * runs → execute) are TWO DIFFERENT LOOPS with different jobs. Do NOT merge.
 *
 * This poller is intentionally THIN. The claim atomicity (mitigation 36), the
 * orphan-recovery predicates (mitigation 37), and the recency floor (R4) all
 * live INSIDE `claimNextPlanningRun` / `recoverOrphanRuns` in
 * `services/agent-runs.ts`. The poller only calls them — it does NOT
 * re-implement any of that safety.
 */

import { type DB, db as realDb } from '../db/client.ts';
import { env } from '../env.ts';
import {
  claimNextPlanningRun,
  countPendingPlanning,
  recoverOrphanRuns,
} from '../services/agent-runs.ts';
import { runAgent as realRunAgent, runAgentResume as realRunAgentResume } from './runner.ts';

/**
 * Injected dependencies for one poll tick. Tests pass fakes for `runAgent` /
 * `runAgentResume` and share a `maxConcurrent` + `inFlight` counter so the
 * concurrency cap is observable without real provider streams or timers.
 */
export interface PollerDeps {
  runAgent: (args: { runId: string }) => Promise<void>;
  runAgentResume: (args: { runId: string }) => Promise<void>;
  maxConcurrent: number;
  /** Mutable in-flight counter shared across ticks (the poller owns one instance). */
  inFlight: { count: number };
}

/**
 * One poll tick: claim up to `(maxConcurrent - inFlight)` planning runs and
 * dispatch each fire-and-forget. Exported for tests.
 *
 * Cap invariant: the while-loop is bounded by `inFlight.count`. Because a
 * dispatch increments `inFlight.count` synchronously (before the await) and
 * only decrements on settle (in `.finally`), a long-running dispatch keeps the
 * counter high so the loop stops claiming once the cap is reached — even though
 * each individual dispatch is non-blocking.
 *
 * Fire-and-forget (`void run(...).catch(...).finally(...)`) guarantees:
 *  - a long run does not block the tick (the loop continues / the interval
 *    fires again), and
 *  - a run REJECTION does not crash the loop (the `.catch` swallows + logs).
 */
export async function runPollerOnce(db: DB, deps: PollerDeps): Promise<void> {
  while (deps.inFlight.count < deps.maxConcurrent) {
    const row = await claimNextPlanningRun(db);
    if (!row) break;

    // Route by frontmatter.resume_of (snake_case): a resume row carries the
    // original run's id and must replay through runAgentResume; a fresh run
    // goes through runAgent. claimNextPlanningRun returns the Document with
    // frontmatter parsed as JSON.
    const fm = row.frontmatter as Record<string, unknown>;
    const isResume = typeof fm.resume_of === 'string';
    const dispatch = isResume ? deps.runAgentResume : deps.runAgent;
    const runId = row.id;

    deps.inFlight.count++;
    void dispatch({ runId })
      .catch((err) => console.error(`[poller] run ${runId} failed`, err))
      .finally(() => {
        deps.inFlight.count--;
      });
  }

  // Backpressure visibility — never throws; a count read is cheap (indexed).
  const pending = await countPendingPlanning(db);
  if (pending > 10) {
    console.warn(`[poller] ${pending} planning runs pending (cap ${deps.maxConcurrent})`);
  }
}

/**
 * Boot the interval-driven poller. Recovers orphaned `running` rows ONCE
 * (fire-and-forget; a recovery failure is logged and does not block the loop),
 * then claims + dispatches each interval. Returns a stop function that clears
 * the timer.
 *
 * `recover` is injectable (defaults to the real `recoverOrphanRuns`) so the
 * boot-recovery behavior is testable without timers; the per-tick claim loop
 * lives in `runPollerOnce`, which is tested directly.
 */
export function startRunnerPoller(
  db: DB = realDb,
  recover: (args: { staleThresholdMs: number }) => Promise<string[]> = recoverOrphanRuns,
): () => void {
  const inFlight = { count: 0 };

  // Boot recovery once, before the first claim. Fire-and-forget: a failure is
  // logged but must not prevent the claim loop from starting.
  void recover({ staleThresholdMs: env.FOLIO_WORKER_STALE_MS }).catch((e) =>
    console.error('[poller] boot recovery', e),
  );

  const deps: PollerDeps = {
    runAgent: realRunAgent,
    runAgentResume: realRunAgentResume,
    maxConcurrent: env.FOLIO_POLLER_CONCURRENCY,
    inFlight,
  };

  // I2 (Phase-3 shake-out): re-entrancy latch — see startEventDispatcher. A
  // slow poller tick (claim + dispatch under load) must not overlap the next
  // and double-claim; skip while the prior tick is still running.
  let running = false;
  const handle = setInterval(() => {
    if (running) return;
    running = true;
    void runPollerOnce(db, deps)
      .catch((err) => console.error('[poller] tick error', err))
      .finally(() => {
        running = false;
      });
  }, env.FOLIO_POLLER_INTERVAL_MS);

  return () => clearInterval(handle);
}
