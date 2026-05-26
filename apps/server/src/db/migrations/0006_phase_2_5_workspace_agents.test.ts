import { describe, expect, test } from 'bun:test';
import Database from 'bun:sqlite';
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

const TARGET = '0006_phase_2_5_workspace_agents.sql';

describe('0006_phase_2_5_workspace_agents migration', () => {
  test('backfills workspace_id from project_id for work_item rows', () => {
    const db = new Database(':memory:');
    setupBaseline(db, TARGET);
    seedWorkspaceAndProject(db);
    db.run(`INSERT INTO documents (id, project_id, type, slug, title) VALUES ('d1', 'p1', 'work_item', 'wi-1', 'WI 1')`);

    applyMigration(db, TARGET);

    const row = db.query(`SELECT workspace_id, project_id, type FROM documents WHERE id = 'd1'`).get() as {
      workspace_id: string;
      project_id: string;
      type: string;
    };
    expect(row.workspace_id).toBe('w1');
    expect(row.project_id).toBe('p1');
    expect(row.type).toBe('work_item');
  });

  test('drops pre-existing agent rows + cascade-revokes their auto-minted tokens', () => {
    const db = new Database(':memory:');
    setupBaseline(db, TARGET);
    seedWorkspaceAndProject(db);
    db.run(`INSERT INTO documents (id, project_id, type, slug, title) VALUES ('a1', 'p1', 'agent', 'old-agent', 'Old')`);
    db.run(`INSERT INTO api_tokens (id, workspace_id, name, token_hash) VALUES ('t1', 'w1', 'agent:old-agent', 'hash1')`);
    db.run(`INSERT INTO api_tokens (id, workspace_id, name, token_hash) VALUES ('t2', 'w1', 'human-pat', 'hash2')`);

    applyMigration(db, TARGET);

    expect(db.query(`SELECT COUNT(*) as n FROM documents WHERE id = 'a1'`).get()).toEqual({ n: 0 });
    expect(db.query(`SELECT COUNT(*) as n FROM api_tokens WHERE id = 't1'`).get()).toEqual({ n: 0 });
    expect(db.query(`SELECT COUNT(*) as n FROM api_tokens WHERE id = 't2'`).get()).toEqual({ n: 1 });
  });

  test('CHECK constraint rejects agent inserted with non-NULL project_id', () => {
    const db = new Database(':memory:');
    setupBaseline(db, TARGET);
    seedWorkspaceAndProject(db);
    applyMigration(db, TARGET);

    expect(() =>
      db.run(
        `INSERT INTO documents (id, project_id, workspace_id, type, slug, title)
         VALUES ('bad', 'p1', 'w1', 'agent', 'bad', 'Bad')`,
      ),
    ).toThrow();
  });

  test('CHECK constraint rejects work_item inserted with NULL project_id', () => {
    const db = new Database(':memory:');
    setupBaseline(db, TARGET);
    seedWorkspaceAndProject(db);
    applyMigration(db, TARGET);

    expect(() =>
      db.run(
        `INSERT INTO documents (id, workspace_id, type, slug, title)
         VALUES ('bad', 'w1', 'work_item', 'bad', 'Bad')`,
      ),
    ).toThrow();
  });

  test('CHECK constraint accepts agent with NULL project_id + non-NULL workspace_id', () => {
    const db = new Database(':memory:');
    setupBaseline(db, TARGET);
    seedWorkspaceAndProject(db);
    applyMigration(db, TARGET);

    db.run(
      `INSERT INTO documents (id, workspace_id, type, slug, title, frontmatter)
       VALUES ('good', 'w1', 'agent', 'good', 'Good', '{"projects":["*"]}')`,
    );
    const row = db.query(`SELECT project_id, workspace_id FROM documents WHERE id = 'good'`).get() as {
      project_id: string | null;
      workspace_id: string;
    };
    expect(row.project_id).toBeNull();
    expect(row.workspace_id).toBe('w1');
  });

  test('api_tokens has agent_id + project_ids columns after migration', () => {
    const db = new Database(':memory:');
    setupBaseline(db, TARGET);
    applyMigration(db, TARGET);

    const cols = db.query(`PRAGMA table_info(api_tokens)`).all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain('agent_id');
    expect(names).toContain('project_ids');
  });

  test('deleting an agent cascades the bound token', () => {
    const db = new Database(':memory:');
    setupBaseline(db, TARGET);
    seedWorkspaceAndProject(db);
    applyMigration(db, TARGET);
    db.run('PRAGMA foreign_keys = ON');

    db.run(
      `INSERT INTO documents (id, workspace_id, type, slug, title, frontmatter)
       VALUES ('a1', 'w1', 'agent', 'a1', 'A1', '{"projects":["*"]}')`,
    );
    db.run(
      `INSERT INTO api_tokens (id, workspace_id, name, token_hash, agent_id)
       VALUES ('t1', 'w1', 'agent:a1', 'hash', 'a1')`,
    );
    expect(db.query(`SELECT COUNT(*) as n FROM api_tokens WHERE id = 't1'`).get()).toEqual({ n: 1 });

    db.run(`DELETE FROM documents WHERE id = 'a1'`);
    expect(db.query(`SELECT COUNT(*) as n FROM api_tokens WHERE id = 't1'`).get()).toEqual({ n: 0 });
  });
});
