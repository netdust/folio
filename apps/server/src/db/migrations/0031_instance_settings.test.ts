import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { resolve } from 'node:path';
import * as schema from '../schema.ts';

test('0031 creates the instance_settings key/value table', () => {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: resolve(import.meta.dir, '.') });
  const cols = (sqlite.query('PRAGMA table_info(instance_settings)').all() as { name: string }[]).map(
    (r) => r.name,
  );
  expect(cols).toContain('key');
  expect(cols).toContain('value');
  expect(cols).toContain('updated_at');
});
