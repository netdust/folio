import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { resolve } from 'node:path';
import * as schema from '../schema.ts';

describe('migration: add users.role', () => {
  test('users has a role column defaulting to member', () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: resolve(import.meta.dir, '.') });
    const cols = sqlite.query(`PRAGMA table_info('users')`).all() as Array<{
      name: string;
      dflt_value: string | null;
    }>;
    const role = cols.find((c) => c.name === 'role');
    expect(role).toBeDefined();
    expect(role?.dflt_value).toContain('member');
  });
});
