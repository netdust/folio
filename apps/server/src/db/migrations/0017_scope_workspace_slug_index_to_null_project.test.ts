import { describe, expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import path from 'node:path';

const MIGRATIONS_FOLDER = path.resolve(import.meta.dir);

// After migration 0017, `documents_workspace_type_slug_idx` is PARTIAL
// (`WHERE project_id IS NULL`). So it uniquely constrains only project-less
// (agent/trigger) docs; project-scoped work_items/pages are governed solely by
// `documents_project_slug_idx` (project_id, slug) and may share a slug across
// different projects in the same workspace.
function freshDb() {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  // Seed a workspace + two projects (FK targets for the documents below).
  sqlite.run(
    `INSERT INTO workspaces (id, slug, name, created_at, updated_at) VALUES ('w1','w1','W1',0,0)`,
  );
  for (const p of ['pA', 'pB']) {
    sqlite.run(
      `INSERT INTO projects (id, workspace_id, slug, name, created_at, updated_at)
       VALUES (?, 'w1', ?, ?, 0, 0)`,
      [p, p, p],
    );
  }
  // A user for created_by/updated_by FKs.
  sqlite.run(
    `INSERT INTO users (id, email, name, created_at) VALUES ('u1','a@b','A',0)`,
  );
  return sqlite;
}

function insertDoc(
  sqlite: Database,
  args: { id: string; projectId: string | null; type: string; slug: string },
): void {
  sqlite.run(
    `INSERT INTO documents
       (id, workspace_id, project_id, table_id, type, slug, title, body, frontmatter, created_by, updated_by, created_at, updated_at)
     VALUES (?, 'w1', ?, NULL, ?, ?, ?, '', '{}', 'u1', 'u1', 0, 0)`,
    [args.id, args.projectId, args.type, args.slug, args.slug],
  );
}

describe('migration 0017 — workspace slug index scoped to project_id IS NULL', () => {
  test('the SAME work_item slug is allowed in DIFFERENT projects of one workspace (the bug fix)', () => {
    const sqlite = freshDb();
    insertDoc(sqlite, { id: 'd1', projectId: 'pA', type: 'work_item', slug: 'untitled' });
    // Pre-0017 this threw UNIQUE constraint (workspace_id,type,slug). Now allowed.
    expect(() =>
      insertDoc(sqlite, { id: 'd2', projectId: 'pB', type: 'work_item', slug: 'untitled' }),
    ).not.toThrow();
    sqlite.close();
  });

  test('the SAME work_item slug in the SAME project still collides (project_slug_idx)', () => {
    const sqlite = freshDb();
    insertDoc(sqlite, { id: 'd1', projectId: 'pA', type: 'work_item', slug: 'untitled' });
    expect(() =>
      insertDoc(sqlite, { id: 'd2', projectId: 'pA', type: 'work_item', slug: 'untitled' }),
    ).toThrow(/UNIQUE/i);
    sqlite.close();
  });

  test('two agents (project_id NULL) with the same slug STILL collide — the partial index does its job', () => {
    const sqlite = freshDb();
    insertDoc(sqlite, { id: 'a1', projectId: null, type: 'agent', slug: 'helper' });
    expect(() =>
      insertDoc(sqlite, { id: 'a2', projectId: null, type: 'agent', slug: 'helper' }),
    ).toThrow(/UNIQUE/i);
    sqlite.close();
  });

  test('an agent and a trigger (both project_id NULL) may share a slug — index keys on type', () => {
    const sqlite = freshDb();
    insertDoc(sqlite, { id: 'a1', projectId: null, type: 'agent', slug: 'daily' });
    expect(() =>
      insertDoc(sqlite, { id: 't1', projectId: null, type: 'trigger', slug: 'daily' }),
    ).not.toThrow();
    sqlite.close();
  });
});
