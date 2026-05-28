import { describe, expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import path from 'node:path';

const MIGRATIONS_FOLDER = path.resolve(import.meta.dir);

function freshMigratedDb() {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}

describe('migration 0012 — agent_run type + indexes', () => {
  test('documents.type CHECK now accepts agent_run', () => {
    const { sqlite } = freshMigratedDb();
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
       VALUES ('t1','p1','runs','Runs', 0)`,
    );
    sqlite.run(
      `INSERT INTO documents (id, project_id, workspace_id, table_id,
        type, slug, title, parent_id, created_at, updated_at)
       VALUES ('parent1','p1','w1','t1',
        'work_item','parent','Parent', NULL, 0, 0)`,
    );

    expect(() =>
      sqlite.run(
        `INSERT INTO documents (id, project_id, workspace_id, table_id,
          type, slug, title, parent_id, status, created_at, updated_at)
         VALUES ('r1','p1','w1','t1',
          'agent_run','run-1','run-1','parent1','planning', 0, 0)`,
      ),
    ).not.toThrow();
  });

  test('agent_run requires workspace_id + project_id + table_id + parent_id', () => {
    const { sqlite } = freshMigratedDb();
    sqlite.run(
      `INSERT INTO workspaces (id, slug, name, created_at, updated_at)
       VALUES ('w1','w1','W1', 0, 0)`,
    );
    expect(() =>
      sqlite.run(
        `INSERT INTO documents (id, workspace_id, type, slug, title, created_at, updated_at)
         VALUES ('r2','w1','agent_run','run-2','run-2', 0, 0)`,
      ),
    ).toThrow();
  });

  test('all four Phase 3 indexes exist', () => {
    const { sqlite } = freshMigratedDb();
    const rows = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='index'`)
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    expect(names).toContain('documents_runs_by_parent_idx');
    expect(names).toContain('documents_runs_by_status_idx');
    expect(names).toContain('documents_runs_pending_idx');
    expect(names).toContain('documents_runs_by_chain_idx');
  });

  test('existing document types still work (no regression)', () => {
    const { sqlite } = freshMigratedDb();
    sqlite.run(
      `INSERT INTO workspaces (id, slug, name, created_at, updated_at)
       VALUES ('w1','w1','W1', 0, 0)`,
    );
    sqlite.run(
      `INSERT INTO projects (id, workspace_id, slug, name, created_at, updated_at)
       VALUES ('p1','w1','p1','P1', 0, 0)`,
    );
    for (const type of ['work_item', 'page', 'agent', 'trigger', 'comment']) {
      expect(() =>
        sqlite.run(
          `INSERT INTO documents (id, project_id, workspace_id,
            type, slug, title, parent_id, created_at, updated_at)
           VALUES ('d-${type}',
            ${type === 'agent' || type === 'trigger' ? 'NULL' : "'p1'"},
            'w1','${type}','slug-${type}','Title',
            ${type === 'comment' ? "'p1'" : 'NULL'},
            0, 0)`,
        ),
      ).not.toThrow();
    }
  });
});
