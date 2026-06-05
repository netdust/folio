import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { resolve } from 'node:path';
import * as schema from '../schema.ts';

describe('migration: access tables', () => {
  test('workspace_access and project_access exist with composite PKs', () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: resolve(import.meta.dir, '.') });
    const wa = sqlite.query(`PRAGMA table_info('workspace_access')`).all() as Array<{ name: string; pk: number }>;
    const pa = sqlite.query(`PRAGMA table_info('project_access')`).all() as Array<{ name: string; pk: number }>;
    expect(wa.filter((c) => c.pk > 0).map((c) => c.name).sort()).toEqual(['user_id', 'workspace_id']);
    expect(pa.filter((c) => c.pk > 0).map((c) => c.name).sort()).toEqual(['project_id', 'user_id']);
    sqlite.close();
  });
});
