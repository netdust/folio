import { expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import path from 'node:path';

const MIGRATIONS_FOLDER = path.resolve(import.meta.dir);

test('0018 adds board_position to documents', () => {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  const cols = (
    sqlite.query(`PRAGMA table_info(documents)`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  expect(cols).toContain('board_position');
  sqlite.close();
});
