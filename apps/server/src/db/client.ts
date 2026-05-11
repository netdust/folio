import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { env } from '../env.ts';
import * as schema from './schema.ts';

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

function realDb(): DrizzleDb {
  const sqlitePath = env.DATABASE_URL.replace(/^file:/, '');
  const sqlite = new Database(sqlitePath);
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec('PRAGMA synchronous = NORMAL');
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
  const override = (globalThis as Record<string, unknown>).__folioTestDb as
    | DrizzleDb
    | undefined;
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

export { schema };
export type DB = DrizzleDb;
