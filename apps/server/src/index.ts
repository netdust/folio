import { app } from './app.ts';
import { db } from './db/client.ts';
import { env } from './env.ts';
import { reconcileAllowLists } from './lib/reconciler.ts';

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

export default {
  port: env.PORT,
  fetch: app.fetch,
};
