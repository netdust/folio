import { app } from './app.ts';
import { runMigrationsOnBoot } from './db/auto-migrate.ts';
import { db } from './db/client.ts';
import { env } from './env.ts';
import { startEventDispatcher } from './lib/event-dispatcher.ts';
import { reconcileAllowLists } from './lib/reconciler.ts';

// Phase 3 A-0: apply any pending migrations at boot so dev environments never
// serve traffic against a stale schema. No-op in NODE_ENV=test.
runMigrationsOnBoot(db);

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

export default {
  port: env.PORT,
  fetch: app.fetch,
};
