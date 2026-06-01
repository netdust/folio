import { app } from './app.ts';
import { runMigrationsOnBoot } from './db/auto-migrate.ts';
import { db } from './db/client.ts';
import { env } from './env.ts';
import { startEventDispatcher } from './lib/event-dispatcher.ts';
import { sweepOrphanedFolioApiTokens } from './lib/folio-api-tool.ts';
import { startRunnerPoller } from './lib/poller.ts';
import { reconcileAllowLists } from './lib/reconciler.ts';

// Phase 3 A-0: apply any pending migrations at boot so dev environments never
// serve traffic against a stale schema. No-op in NODE_ENV=test.
runMigrationsOnBoot(db);

// Backstop for dispatchAsCaller's minted tokens: clear any left live by a
// crash/revoke-failure on a prior run. These are per-request ephemerals.
void sweepOrphanedFolioApiTokens(db)
  .then((n) => {
    if (n > 0) console.log(`[folio] swept ${n} orphaned folio_api token(s)`);
  })
  .catch((err) => console.error('[folio] folio_api token sweep failed', err));

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
