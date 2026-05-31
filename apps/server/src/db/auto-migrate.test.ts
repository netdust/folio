import { describe, expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { runMigrationsOnBoot } from './auto-migrate.ts';
import * as schema from './schema.ts';

describe('runMigrationsOnBoot', () => {
  test('applies all migrations to a fresh DB and is idempotent on second call', () => {
    const originalEnv = process.env.NODE_ENV;
    // Force non-test so the boot path executes against this scratch DB.
    process.env.NODE_ENV = 'development';

    try {
      const sqlite = new Database(':memory:');
      const db = drizzle(sqlite, { schema });

      runMigrationsOnBoot(db);

      const count1 = sqlite
        .prepare(`SELECT COUNT(*) as n FROM __drizzle_migrations`)
        .get() as { n: number };
      expect(count1.n).toBeGreaterThan(0);

      runMigrationsOnBoot(db); // second call must not throw or re-run anything
      const count2 = sqlite
        .prepare(`SELECT COUNT(*) as n FROM __drizzle_migrations`)
        .get() as { n: number };
      expect(count2.n).toBe(count1.n);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  test('does NOT run in NODE_ENV=test (test harness owns migrations)', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';

    try {
      const sqlite = new Database(':memory:');
      const db = drizzle(sqlite, { schema });
      runMigrationsOnBoot(db);

      const row = sqlite
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'`,
        )
        .get();
      expect(row).toBeNull();
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});
