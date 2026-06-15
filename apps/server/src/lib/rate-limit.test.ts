import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import * as schema from '../db/schema.ts';
import { env } from '../env.ts';
import { checkRateLimit } from './rate-limit.ts';

function makeDb() {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: resolve(import.meta.dir, '../db/migrations') });
  return db;
}

describe('checkRateLimit', () => {
  test('allows up to the threshold then denies the next attempt (login=5)', async () => {
    const db = makeDb();
    const at = 1_700_000_000_000;
    // Threshold is FOLIO_RATE_LIMIT_LOGIN (default 5). The first `threshold`
    // calls are allowed; the (threshold+1)-th is throttled.
    const threshold = env.FOLIO_RATE_LIMIT_LOGIN;
    for (let i = 0; i < threshold; i++) {
      expect(await checkRateLimit(db, 'login', 'ip:1.2.3.4', at)).toBe(true);
    }
    // The (threshold+1)-th attempt in the same window is denied.
    expect(await checkRateLimit(db, 'login', 'ip:1.2.3.4', at)).toBe(false);
  });

  test('resets after the window elapses (advance past windowMs → allowed again)', async () => {
    const db = makeDb();
    const start = 1_700_000_000_000;
    const threshold = env.FOLIO_RATE_LIMIT_LOGIN;
    // Exhaust the window.
    for (let i = 0; i < threshold; i++) {
      await checkRateLimit(db, 'login', 'ip:9.9.9.9', start);
    }
    expect(await checkRateLimit(db, 'login', 'ip:9.9.9.9', start)).toBe(false);
    // Advance past the window — the counter resets, attempts are allowed again.
    const after = start + env.FOLIO_RATE_LIMIT_WINDOW_MS + 1;
    expect(await checkRateLimit(db, 'login', 'ip:9.9.9.9', after)).toBe(true);
  });

  test('counts are isolated per (scope, key)', async () => {
    const db = makeDb();
    const at = 1_700_000_000_000;
    const threshold = env.FOLIO_RATE_LIMIT_LOGIN;
    // Exhaust one key; a different key under the same scope is unaffected.
    for (let i = 0; i < threshold; i++) {
      await checkRateLimit(db, 'login', 'ip:1.1.1.1', at);
    }
    expect(await checkRateLimit(db, 'login', 'ip:1.1.1.1', at)).toBe(false);
    expect(await checkRateLimit(db, 'login', 'ip:2.2.2.2', at)).toBe(true);
    // A different scope for the SAME key is also a separate counter.
    expect(await checkRateLimit(db, 'magic_link', 'ip:1.1.1.1', at)).toBe(true);
  });

  test('FAILS OPEN when the store errors (availability > throttle)', async () => {
    // CR-C1 / audit A1: the throttle store is a safety net, not the auth boundary.
    // If the counter write throws (disk full, locked db, schema drift), the request
    // must be ALLOWED, not 500'd — bricking /login on a throttle-table fault is worse
    // than missing one rate-limit tick. This pins that contract: a refactor that
    // turned the catch into fail-CLOSED (return false / rethrow) would go RED here.
    const throwingDb = {
      insert() {
        throw new Error('simulated store failure');
      },
    } as unknown as Parameters<typeof checkRateLimit>[0];

    expect(await checkRateLimit(throwingDb, 'login', 'ip:9.9.9.9', 1_700_000_000_000)).toBe(true);
  });
});
