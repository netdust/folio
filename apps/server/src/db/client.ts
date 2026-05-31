import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { env } from '../env.ts';
import * as schema from './schema.ts';

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

declare global {
  // eslint-disable-next-line no-var
  var __folioTestDb: DrizzleDb | undefined;
}

function realDb(): DrizzleDb {
  const sqlitePath = env.DATABASE_URL.replace(/^file:/, '');
  const sqlite = new Database(sqlitePath);
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('PRAGMA synchronous = NORMAL');
  // R9 fix (post-review-of-review) — wait up to 5s for the SQLite writer
  // lock before returning SQLITE_BUSY. Required for concurrent-write
  // patterns introduced by Phase 3 (claimNextPlanningRun race,
  // ensureRunsTable's ON CONFLICT DO NOTHING + re-fetch). Without this,
  // a tx that arrives while another holds the write lock would receive
  // SQLITE_BUSY immediately rather than waiting — surfacing as opaque
  // 500s under runner / poller load.
  sqlite.exec('PRAGMA busy_timeout = 5000');
  return drizzle(sqlite, { schema });
}

let _resolved: DrizzleDb | undefined;

/**
 * Resolve the actual Drizzle instance. Honors a test override at
 * `globalThis.__folioTestDb` if present at first access. Lazy on purpose: the
 * test harness sets the override AFTER its static imports have evaluated, so
 * we cannot resolve at module load.
 */
function resolve(): DrizzleDb {
  if (_resolved) return _resolved;
  const override = globalThis.__folioTestDb;
  _resolved = override ?? realDb();
  return _resolved;
}

// Proxy so existing `import { db } from '...'` call sites work unchanged while
// the underlying instance is resolved lazily on first use.
export const db = new Proxy({} as DrizzleDb, {
  get(_t, prop) {
    const target = resolve() as unknown as Record<PropertyKey, unknown>;
    const value = target[prop];
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
  },
}) as DrizzleDb;

/**
 * Test-only: clears the cached resolution so the next `db` access re-reads
 * `globalThis.__folioTestDb` (or falls back to `realDb()`).
 *
 * Required because `makeTestApp()` may be called multiple times within a
 * single test file. The module-level `_resolved` cache would otherwise pin
 * routes to the DB from the first call.
 */
export function __resetDbForTests(): void {
  _resolved = undefined;
}

export { schema };
export type DB = DrizzleDb;
