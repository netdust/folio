import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { resolve } from 'node:path';
import * as schema from '../schema.ts';

describe('migration: instance_skills', () => {
  test('instance_skills has a typed trusted column default 0 (not in frontmatter)', () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: resolve(import.meta.dir, '.') });
    const cols = sqlite.query(`PRAGMA table_info('instance_skills')`).all() as Array<{
      name: string;
      dflt_value: string | null;
    }>;
    const trusted = cols.find((c) => c.name === 'trusted');
    expect(trusted).toBeDefined(); // a real column, not buried in frontmatter json
    expect(trusted?.dflt_value).toBe('0');
    expect(cols.find((c) => c.name === 'name')).toBeDefined();
    expect(cols.find((c) => c.name === 'body')).toBeDefined();
    // name is unique
    const idx = sqlite.query(`PRAGMA index_list('instance_skills')`).all() as Array<{
      name: string;
      unique: number;
    }>;
    expect(idx.some((i) => i.unique === 1)).toBe(true);
    sqlite.close();
  });
});
