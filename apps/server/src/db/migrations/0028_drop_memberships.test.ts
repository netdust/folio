import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import * as schema from '../schema.ts';

/**
 * Apply a hand-authored migration's SQL the way drizzle's migrate() does — split
 * on the `--> statement-breakpoint` marker and exec each statement separately.
 * bun:sqlite's exec() mishandles the marker, silently running only the first
 * statement (see memory: bun-sqlite-exec-no-ops-migration-guard).
 */
function applyMigration(sqlite: Database, file: string): void {
  const sql = readFileSync(resolve(import.meta.dir, file), 'utf8');
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const trimmed = stmt.trim();
    if (trimmed) sqlite.exec(trimmed);
  }
}

describe('Phase 4 contract migrations — __system teardown + drop memberships', () => {
  test('after all migrations, memberships is gone and no __system workspace remains', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec('PRAGMA foreign_keys = ON');
    migrate(drizzle(sqlite, { schema }), {
      migrationsFolder: resolve(import.meta.dir, '.'),
    });

    const membershipsTbl = sqlite
      .query(`SELECT name FROM sqlite_master WHERE type='table' AND name='memberships'`)
      .all();
    expect(membershipsTbl.length).toBe(0);

    const systemWs = sqlite
      .query(`SELECT id FROM workspaces WHERE slug='__system'`)
      .all();
    expect(systemWs.length).toBe(0);
  });

  test('0027 teardown DELETES a seeded __system + its projects/documents/memberships, and LEAVES other workspaces', () => {
    // The full-migrate tests above can't exercise the teardown's DELETE
    // statements: a post-refactor fresh DB NEVER creates __system (bootstrap is
    // gone), so the deletes match zero rows. A REAL upgrading instance DOES have
    // a __system cluster. Reconstruct that world: migrate fully, re-create the
    // dropped `memberships` table, seed a __system cluster + a customer
    // workspace, then re-run the 0027 teardown SQL and assert the cascade.
    const sqlite = new Database(':memory:');
    sqlite.exec('PRAGMA foreign_keys = ON');
    migrate(drizzle(sqlite, { schema }), { migrationsFolder: resolve(import.meta.dir, '.') });

    // memberships was dropped by 0028 — recreate its 0000 shape so we can seed it.
    sqlite.exec(`CREATE TABLE memberships (
      workspace_id text NOT NULL,
      user_id text NOT NULL,
      role text DEFAULT 'member' NOT NULL,
      created_at integer DEFAULT (unixepoch() * 1000) NOT NULL,
      PRIMARY KEY (workspace_id, user_id)
    )`);

    // Seed a __system cluster + a CUSTOMER workspace that must SURVIVE.
    sqlite.exec(`INSERT INTO users (id, email, name) VALUES ('u1', 'a@x.com', 'A')`);
    sqlite.exec(`INSERT INTO workspaces (id, slug, name) VALUES ('sys', '__system', 'System')`);
    sqlite.exec(`INSERT INTO workspaces (id, slug, name) VALUES ('cust', 'acme', 'Acme')`);
    sqlite.exec(`INSERT INTO projects (id, workspace_id, slug, name) VALUES ('sp', 'sys', 'skills', 'Skills')`);
    sqlite.exec(`INSERT INTO projects (id, workspace_id, slug, name) VALUES ('cp', 'cust', 'web', 'Web')`);
    sqlite.exec(`INSERT INTO documents (id, workspace_id, project_id, type, slug, title, body) VALUES ('sd', 'sys', 'sp', 'page', 'folio', 'folio', 'x')`);
    sqlite.exec(`INSERT INTO documents (id, workspace_id, project_id, type, slug, title, body) VALUES ('cd', 'cust', 'cp', 'work_item', 'task', 'Task', 'y')`);
    sqlite.exec(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ('sys', 'u1', 'owner')`);

    // Run ONLY the 0027 teardown SQL (split on the breakpoint, like migrate()).
    applyMigration(sqlite, '0027_drop_system_workspace.sql');

    // __system cluster GONE.
    const sysWs = sqlite.query(`SELECT id FROM workspaces WHERE slug='__system'`).all();
    expect(sysWs.length).toBe(0);
    const sysProj = sqlite.query(`SELECT id FROM projects WHERE workspace_id='sys'`).all();
    expect(sysProj.length).toBe(0);
    const sysDoc = sqlite.query(`SELECT id FROM documents WHERE workspace_id='sys'`).all();
    expect(sysDoc.length).toBe(0);
    const sysMem = sqlite.query(`SELECT user_id FROM memberships WHERE workspace_id='sys'`).all();
    expect(sysMem.length).toBe(0);

    // The CUSTOMER workspace + its project + document SURVIVE (the teardown is
    // keyed on the __system slug, not a blanket wipe).
    expect(sqlite.query(`SELECT id FROM workspaces WHERE slug='acme'`).all().length).toBe(1);
    expect(sqlite.query(`SELECT id FROM projects WHERE id='cp'`).all().length).toBe(1);
    expect(sqlite.query(`SELECT id FROM documents WHERE id='cd'`).all().length).toBe(1);

    // Idempotent: re-running the teardown on the now-clean DB is a harmless no-op.
    applyMigration(sqlite, '0027_drop_system_workspace.sql');
    expect(sqlite.query(`SELECT id FROM workspaces WHERE slug='acme'`).all().length).toBe(1);
  });
});
