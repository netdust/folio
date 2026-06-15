/**
 * Auth rate limiting (M1, audit H6; threat-model M2/M3/SA-1/SA-2/SA-4).
 *
 * A SQLite-backed per-(scope, key) FIXED-WINDOW counter. NO sidecar — architectural
 * rule #2 forbids Redis/a separate service; the throttle store is just a table
 * (`auth_rate_limits`) upserted in place. One row per (scope, key); `window_start`
 * is the ms epoch the current window opened, `count` the attempts within it.
 *
 * The mutation is a SINGLE atomic upsert (insert-or-update with a CASE on the
 * stored window): if the existing window has elapsed we RESET (window_start = now,
 * count = 1); otherwise we INCREMENT. The composite PK is the conflict target, so
 * concurrent attempts on the same key serialize on the row write (busy_timeout
 * makes them wait, not error). We then read the resulting count back to decide.
 *
 * FAIL-OPEN (F-A4, the mid-flow-failure edge): if the store errors, we LOG and
 * return `true` (allowed). A throttle is a safety net, not the security boundary —
 * availability of /login must not hinge on the counter table. The real auth
 * decision (password verify, link provenance) is unaffected by a fail-open here.
 */

import { sql } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { authRateLimits } from '../db/schema.ts';
import { env } from '../env.ts';

// Local alias matching the reaper precedent (services/pending-ops.ts): `DBOrTx`
// is NOT exported from db/client.ts, so we derive it from the exported `DB` type.
type DBOrTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

/** Per-scope attempt ceiling within one window. Knobs live on the env singleton
 *  (SA-1) — never read `process.env` here. An unknown scope falls back to the
 *  login ceiling (the stricter-by-default of the two v1 scopes). */
function thresholdFor(scope: string): number {
  switch (scope) {
    case 'login':
      return env.FOLIO_RATE_LIMIT_LOGIN;
    case 'magic_link':
      return env.FOLIO_RATE_LIMIT_MAGIC_LINK;
    default:
      return env.FOLIO_RATE_LIMIT_LOGIN;
  }
}

/**
 * Record one attempt against (scope, key) and decide whether it is allowed.
 *
 * @returns `true` = allowed (within the window's threshold), `false` = throttle.
 *          Fails OPEN (returns `true`) on any store error.
 */
export async function checkRateLimit(
  db: DBOrTx,
  scope: string,
  key: string,
  at: number = Date.now(),
): Promise<boolean> {
  const windowMs = env.FOLIO_RATE_LIMIT_WINDOW_MS;
  const threshold = thresholdFor(scope);

  try {
    // Atomic upsert: a fresh key inserts {count:1, window_start:at}. An existing
    // key whose window has elapsed RESETS to {count:1, window_start:at}; otherwise
    // it INCREMENTS in the current window. `excluded` is the would-be-inserted row.
    await db
      .insert(authRateLimits)
      .values({ scope, key, count: 1, windowStart: at })
      .onConflictDoUpdate({
        target: [authRateLimits.scope, authRateLimits.key],
        set: {
          count: sql`CASE
            WHEN ${authRateLimits.windowStart} <= ${at - windowMs}
              THEN 1
              ELSE ${authRateLimits.count} + 1
          END`,
          windowStart: sql`CASE
            WHEN ${authRateLimits.windowStart} <= ${at - windowMs}
              THEN ${at}
              ELSE ${authRateLimits.windowStart}
          END`,
        },
      });

    const [row] = await db
      .select({ count: authRateLimits.count })
      .from(authRateLimits)
      .where(sql`${authRateLimits.scope} = ${scope} AND ${authRateLimits.key} = ${key}`);

    const count = row?.count ?? 1;
    return count <= threshold;
  } catch (err) {
    // Fail OPEN — the throttle store is a safety net, not the auth boundary.
    console.error(`[rate-limit] store error for ${scope}/${key}, failing open:`, err);
    return true;
  }
}
