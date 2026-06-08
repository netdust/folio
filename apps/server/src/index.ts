import { app } from './app.ts';
import { runMigrationsOnBoot } from './db/auto-migrate.ts';
import { db } from './db/client.ts';
import { env } from './env.ts';
import { startEventDispatcher } from './lib/event-dispatcher.ts';
import { sweepOrphanedFolioApiTokens } from './lib/folio-api-tool.ts';
import { recoverInterruptedConversations } from './services/conversations.ts';
import { startRunnerPoller } from './lib/poller.ts';
import { reconcileAllowLists } from './lib/reconciler.ts';
import { reapStalePendingOps } from './services/pending-ops.ts';
import { runBootTasks } from './lib/system-workspace.ts';

// Phase 3 A-0: apply any pending migrations at boot so dev environments never
// serve traffic against a stale schema. No-op in NODE_ENV=test.
runMigrationsOnBoot(db);

// Phase A (M4/M5/M8): bootstrap the __system library workspace and, if
// FOLIO_INSTANCE_OWNER resolves to an existing user, designate the instance
// owner. Async + fire-and-log (the module body isn't async), mirroring the
// folio_api token sweep below. Test-gated like the timer-starters so importing
// index.ts in tests does NOT trigger a real bootstrap; runBootTasks itself is
// invoked directly against a test db by its unit tests.
if (env.NODE_ENV !== 'test') {
  void runBootTasks(db, env).catch((err) =>
    console.error('[folio] boot tasks failed', err),
  );
}

// Backstop for dispatchAsCaller's minted tokens: clear any left live by a
// crash/revoke-failure on a prior run. These are per-request ephemerals.
void sweepOrphanedFolioApiTokens(db)
  .then((n) => {
    if (n > 0) console.log(`[folio] swept ${n} orphaned folio_api token(s)`);
  })
  .catch((err) => console.error('[folio] folio_api token sweep failed', err));

// Operator cockpit chat (Task 8, M12): clear dangling conversation run slots from
// a crash/restart and append an interrupted-turn summary. A conversation run has
// no agent_run row, so the runner's orphaned-run recovery never reaches it — this
// is the dedicated sweep. Fire-and-log like the token sweep above.
void recoverInterruptedConversations(db)
  .then((n) => {
    if (n > 0) console.log(`[folio] recovered ${n} interrupted conversation turn(s)`);
  })
  .catch((err) => console.error('[folio] conversation recovery failed', err));

// pending_ops disk hygiene: the confirm-gate flips status but never deletes, so the
// table only grows. Reap terminal/abandoned rows past the retention window. Live
// (pending-within-TTL / confirmed) rows are never touched. Fire-and-log like above.
void reapStalePendingOps(db)
  .then((n) => {
    if (n > 0) console.log(`[folio] reaped ${n} stale pending_ops row(s)`);
  })
  .catch((err) => console.error('[folio] pending_ops reap failed', err));

console.log(`[folio] listening on http://localhost:${env.PORT}`);

// Phase 2.6 sub-phase E1: periodic allow-list reconciler. Scrubs orphan
// project ids from agent allow-lists. Skipped in test mode to avoid timer
// leaks across test runs.
if (env.NODE_ENV !== 'test') {
  console.log(
    `[folio] reconciler enabled (interval: ${env.FOLIO_RECONCILER_INTERVAL_MS}ms)`,
  );
  setInterval(() => {
    reconcileAllowLists(db).catch((err) =>
      console.error('[folio] reconciler error', err),
    );
  }, env.FOLIO_RECONCILER_INTERVAL_MS);
} else {
  console.log('[folio] reconciler disabled (test mode)');
}

// pending_ops reaper interval (slow hygiene loop). Skipped in test mode (timer leaks).
if (env.NODE_ENV !== 'test') {
  setInterval(() => {
    reapStalePendingOps(db).catch((err) =>
      console.error('[folio] pending_ops reaper error', err),
    );
  }, env.FOLIO_RECONCILER_INTERVAL_MS);
}

// Phase 3 C-10b: durable event dispatcher (Reaction Plane). Polls the events
// table by seq and fans out to registered reactors via per-reactor cursors.
// Skipped in test mode to avoid timer leaks across test runs.
if (env.NODE_ENV !== 'test') {
  console.log(
    `[folio] event dispatcher enabled (interval: ${env.FOLIO_DISPATCHER_INTERVAL_MS}ms)`,
  );
  startEventDispatcher(db);
}

// Phase 3 C-12: runner poller (Reaction Plane). Claims `planning` agent_run
// rows ~every interval and dispatches them to the runner, bounded by a
// concurrency cap, recovering orphaned `running` rows once on boot. Skipped in
// test mode to avoid timer leaks across test runs.
if (env.NODE_ENV !== 'test') {
  console.log(
    `[folio] runner poller enabled (interval: ${env.FOLIO_POLLER_INTERVAL_MS}ms, concurrency: ${env.FOLIO_POLLER_CONCURRENCY})`,
  );
  startRunnerPoller(db);
}

// F shake-out (F-4 live e2e): disable Bun's idle-connection reaper.
//
// Bun.serve applies a 10s idleTimeout to a plain `{ port, fetch }` export. An
// SSE stream (routes/events.ts — the provider-health / reactor-halt banners +
// runs live-sync) is idle between events, so Bun killed the socket at 10s,
// 20s BEFORE the 30s keep-alive heartbeat could fire → a reconnect storm
// (observed as `vite http proxy error: socket hang up` on /events). Bun's idle
// timer is not reliably reset by the server's own heartbeat writes (which is
// why Bun's SSE guidance is to DISABLE the timeout, not raise it), and
// Hono-on-Bun can't reach the per-request `server.timeout(req, 0)`. So we
// disable it globally here — which is also Bun's own post-1.1.27 default and
// the correct policy for an app whose core surfaces are long-lived streams.
// (No `satisfies` type: @types/bun's serve-options type isn't cleanly named
// across versions; `index.test.ts` pins `idleTimeout === 0` at runtime, which
// is the guard that matters. Bun reads these keys off the default export.)
export default {
  port: env.PORT,
  idleTimeout: 0,
  fetch: app.fetch,
};
