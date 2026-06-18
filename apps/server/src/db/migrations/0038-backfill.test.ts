import Database from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';

const MIGRATIONS_FOLDER = path.resolve(import.meta.dir);

function readMigrationSql(): string {
  return readFileSync(path.join(MIGRATIONS_FOLDER, '0038_backfill_list_to_table.sql'), 'utf8');
}

function seedView(sqlite: Database, id: string, type: string): void {
  // `views` (final shape) requires id, project_id, table_id, name, type.
  // project_id/table_id FK to the p1/t1 rows seeded in setup().
  sqlite.run(
    `INSERT INTO views (id, project_id, table_id, name, type, created_at)
     VALUES (?, 'p1', 't1', ?, ?, 0)`,
    [id, `view-${id}`, type],
  );
}

function readType(sqlite: Database, id: string): string {
  const row = sqlite.prepare('SELECT type FROM views WHERE id = ?').get(id) as { type: string };
  return row.type;
}

function setup(): Database {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite);
  // Applies ALL migrations up to and including 0038 → final `views` shape.
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  sqlite.run(
    `INSERT INTO workspaces (id, slug, name, created_at, updated_at)
     VALUES ('w1','w1','W1', 0, 0)`,
  );
  sqlite.run(
    `INSERT INTO projects (id, workspace_id, slug, name, created_at, updated_at)
     VALUES ('p1','w1','p1','P1', 0, 0)`,
  );
  sqlite.run(
    `INSERT INTO tables (id, project_id, slug, name, created_at)
     VALUES ('t1','p1','t1','T1', 0)`,
  );
  return sqlite;
}

describe('migration 0038 — backfill list -> table view rows', () => {
  test('rewrites existing `list` rows to `table`, leaves `kanban` and `table` untouched', () => {
    const sqlite = setup();
    seedView(sqlite, 'v-list', 'list');
    seedView(sqlite, 'v-kanban', 'kanban');
    seedView(sqlite, 'v-table', 'table');

    // migrate() won't replay 0038 (journal idempotency) — exec the SQL directly
    // against the pre-seeded NON-EMPTY table.
    const changedBefore = sqlite
      .prepare("SELECT count(*) AS n FROM views WHERE type = 'list'")
      .get() as { n: number };
    expect(changedBefore.n).toBe(1); // guard: the seed actually landed a `list` row

    sqlite.exec(readMigrationSql());

    expect(readType(sqlite, 'v-list')).toBe('table');
    expect(readType(sqlite, 'v-kanban')).toBe('kanban');
    expect(readType(sqlite, 'v-table')).toBe('table');

    // The exec actually mutated rows — no silent no-op.
    const remainingList = sqlite
      .prepare("SELECT count(*) AS n FROM views WHERE type = 'list'")
      .get() as { n: number };
    expect(remainingList.n).toBe(0);
  });

  test('is idempotent — a second exec is a no-op (no `list` rows remain to rewrite)', () => {
    const sqlite = setup();
    seedView(sqlite, 'v-list', 'list');
    seedView(sqlite, 'v-kanban', 'kanban');

    sqlite.exec(readMigrationSql());
    sqlite.exec(readMigrationSql());

    expect(readType(sqlite, 'v-list')).toBe('table');
    expect(readType(sqlite, 'v-kanban')).toBe('kanban');
  });
});
