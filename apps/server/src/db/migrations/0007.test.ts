import Database from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = import.meta.dir;

/** Apply a migration file the same way Drizzle's bun-sqlite migrator does:
 *  split on `--> statement-breakpoint`, exec each chunk. */
function applyMigration(db: Database, filename: string): void {
  const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf-8');
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const trimmed = stmt.trim();
    if (trimmed) db.exec(trimmed);
  }
}

/** Apply every migration with idx < the given one, in order. */
function setupBaseline(db: Database, before: string): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && f < before)
    .sort();
  for (const f of files) applyMigration(db, f);
}

function seedWorkspaceAndProject(db: Database): void {
  db.run(`INSERT INTO users (id, email, name) VALUES ('u1', 'a@b.c', 'A')`);
  db.run(`INSERT INTO workspaces (id, slug, name) VALUES ('w1', 'ws', 'WS')`);
  db.run(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ('w1', 'u1', 'owner')`);
  db.run(`INSERT INTO projects (id, workspace_id, slug, name) VALUES ('p1', 'w1', 'proj', 'Proj')`);
}

const TARGET = '0007_phase_2_6_comments.sql';

describe('0007_phase_2_6_comments migration', () => {
  test('accepts a comment row with parent_id set and table_id null when a valid work_item parent exists', () => {
    const db = new Database(':memory:');
    setupBaseline(db, TARGET);
    seedWorkspaceAndProject(db);
    applyMigration(db, TARGET);

    // Insert a valid work_item parent
    db.run(
      `INSERT INTO documents (id, workspace_id, project_id, type, slug, title)
       VALUES ('parent1', 'w1', 'p1', 'work_item', 'parent-wi', 'Parent WI')`,
    );

    // Insert a comment referencing the parent
    db.run(
      `INSERT INTO documents (id, workspace_id, project_id, type, slug, title, parent_id)
       VALUES ('c1', 'w1', 'p1', 'comment', 'comment-1', 'Comment 1', 'parent1')`,
    );

    const row = db
      .query(`SELECT type, parent_id, table_id FROM documents WHERE id = 'c1'`)
      .get() as {
      type: string;
      parent_id: string;
      table_id: string | null;
    };
    expect(row.type).toBe('comment');
    expect(row.parent_id).toBe('parent1');
    expect(row.table_id).toBeNull();
  });

  test('CHECK constraint rejects a comment row without parent_id', () => {
    const db = new Database(':memory:');
    setupBaseline(db, TARGET);
    seedWorkspaceAndProject(db);
    applyMigration(db, TARGET);

    expect(() =>
      db.run(
        `INSERT INTO documents (id, workspace_id, project_id, type, slug, title)
         VALUES ('bad', 'w1', 'p1', 'comment', 'bad-comment', 'Bad Comment')`,
      ),
    ).toThrow();
  });

  test('CHECK constraint rejects a comment row with table_id set (table_id IS NULL branch)', () => {
    const db = new Database(':memory:');
    setupBaseline(db, TARGET);
    seedWorkspaceAndProject(db);
    // Seed a tables row so table_id='tbl1' satisfies the FK — we want the CHECK to fire,
    // not the FK. Without this row the FK would reject first and we wouldn't know which
    // constraint triggered.
    db.run(`INSERT INTO tables (id, project_id, slug, name) VALUES ('tbl1', 'p1', 't1', 'T')`);
    applyMigration(db, TARGET);

    db.run(
      `INSERT INTO documents (id, workspace_id, project_id, type, slug, title)
       VALUES ('parent1', 'w1', 'p1', 'work_item', 'parent-wi', 'Parent WI')`,
    );

    // A comment with table_id set violates the CHECK: comment requires table_id IS NULL
    expect(() =>
      db.run(
        `INSERT INTO documents (id, workspace_id, project_id, type, slug, title, parent_id, table_id)
         VALUES ('bad', 'w1', 'p1', 'comment', 'bad-comment', 'Bad Comment', 'parent1', 'tbl1')`,
      ),
    ).toThrow();
  });

  test('CHECK constraint still accepts work_item rows under the new CHECK', () => {
    const db = new Database(':memory:');
    setupBaseline(db, TARGET);
    seedWorkspaceAndProject(db);
    applyMigration(db, TARGET);

    // work_item only requires project_id IS NOT NULL — regression guard for the rewritten CHECK
    expect(() =>
      db.run(
        `INSERT INTO documents (id, workspace_id, project_id, type, slug, title)
         VALUES ('w1d1', 'w1', 'p1', 'work_item', 'task-1', 'Task 1')`,
      ),
    ).not.toThrow();
  });

  test('index documents_comments_idx exists after migration', () => {
    const db = new Database(':memory:');
    setupBaseline(db, TARGET);
    applyMigration(db, TARGET);

    const indexes = db
      .query(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'documents_comments_idx'`,
      )
      .all() as { name: string }[];
    expect(indexes.length).toBe(1);
    expect(indexes[0].name).toBe('documents_comments_idx');
  });
});
