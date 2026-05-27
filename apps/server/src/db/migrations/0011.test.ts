/**
 * 0011 — backfill comment frontmatter.target_agent_id from target_agent (BUG-013).
 *
 * Mirrors 0008's pattern. Unlike 0008's author-id backfill, there is no
 * "slug reuse" hijack vector here: binding target_agent_id to the CURRENT
 * holder of the slug is what a user reading the comment today would do.
 */
import Database from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = import.meta.dir;

function applyMigration(db: Database, filename: string): void {
  const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf-8');
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const trimmed = stmt.trim();
    if (trimmed) db.exec(trimmed);
  }
}

function setupBaseline(db: Database, before: string): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && f < before)
    .sort();
  for (const f of files) applyMigration(db, f);
}

function seed(db: Database): void {
  db.run(`INSERT INTO users (id, email, name) VALUES ('u1', 'a@b.c', 'A')`);
  db.run(`INSERT INTO workspaces (id, slug, name) VALUES ('w1', 'ws', 'WS')`);
  db.run(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ('w1', 'u1', 'owner')`);
  db.run(`INSERT INTO projects (id, workspace_id, slug, name) VALUES ('p1', 'w1', 'proj', 'Proj')`);
  db.run(`INSERT INTO tables (id, project_id, slug, name, "order") VALUES ('t1', 'p1', 'work', 'Work', 0)`);
  db.run(
    `INSERT INTO documents (id, workspace_id, project_id, table_id, type, slug, title, body, frontmatter, created_by, updated_by, parent_id)
     VALUES ('parent', 'w1', 'p1', 't1', 'work_item', 'p', 'Parent', '', '{}', 'u1', 'u1', NULL)`,
  );
}

function insertAgent(db: Database, id: string, slug: string, createdAt?: number): void {
  const ts = createdAt ?? Date.now();
  db.run(
    `INSERT INTO documents (id, workspace_id, project_id, table_id, type, slug, title, body, frontmatter, created_by, updated_by, parent_id, created_at, updated_at)
     VALUES ('${id}', 'w1', NULL, NULL, 'agent', '${slug}', 'Agent', '',
       '{"system_prompt":"x","model":"m","provider":"anthropic","tools":[]}',
       'u1', 'u1', NULL, ${ts}, ${ts})`,
  );
}

function insertApprovalComment(
  db: Database,
  id: string,
  slug: string,
  targetAgent: string,
  kind: 'approval' | 'rejection' = 'approval',
): void {
  const fm = JSON.stringify({
    author: 'user:u1',
    kind,
    visibility: 'normal',
    mentions: [],
    target_agent: targetAgent,
  });
  db.run(
    `INSERT INTO documents (id, workspace_id, project_id, table_id, type, slug, title, body, frontmatter, created_by, updated_by, parent_id)
     VALUES ('${id}', 'w1', 'p1', NULL, 'comment', '${slug}', '', 'hi',
       json('${fm}'),
       'u1', 'u1', 'parent')`,
  );
}

function getTargetAgentId(db: Database, commentId: string): string | null {
  const row = db
    .query(`SELECT json_extract(frontmatter, '$.target_agent_id') AS x FROM documents WHERE id = ?`)
    .get(commentId) as { x: string | null };
  return row.x;
}

function getFm(db: Database, commentId: string): Record<string, unknown> {
  const row = db
    .query(`SELECT frontmatter FROM documents WHERE id = ?`)
    .get(commentId) as { frontmatter: string };
  return JSON.parse(row.frontmatter);
}

const TARGET = '0011_phase_2_6_target_agent_id_backfill.sql';

describe('0011 target_agent_id backfill migration', () => {
  test('writes target_agent_id for approval comments whose bare-slug target_agent resolves to a live agent', () => {
    const db = new Database(':memory:');
    setupBaseline(db, TARGET);
    seed(db);
    insertAgent(db, 'agent-x', 'drafter');
    insertApprovalComment(db, 'c1', 'comment-1', 'drafter');

    applyMigration(db, TARGET);

    expect(getTargetAgentId(db, 'c1')).toBe('agent-x');
    // Slug-form `target_agent` is preserved alongside.
    expect(getFm(db, 'c1').target_agent).toBe('drafter');
  });

  test('writes target_agent_id when target_agent uses `agent:<slug>` prefixed form', () => {
    const db = new Database(':memory:');
    setupBaseline(db, TARGET);
    seed(db);
    insertAgent(db, 'agent-x', 'drafter');
    insertApprovalComment(db, 'c1', 'comment-1', 'agent:drafter');

    applyMigration(db, TARGET);

    expect(getTargetAgentId(db, 'c1')).toBe('agent-x');
  });

  test('writes target_agent_id when target_agent is already an id (loops back to itself)', () => {
    const db = new Database(':memory:');
    setupBaseline(db, TARGET);
    seed(db);
    insertAgent(db, 'agent-x', 'drafter');
    insertApprovalComment(db, 'c1', 'comment-1', 'agent-x');

    applyMigration(db, TARGET);

    expect(getTargetAgentId(db, 'c1')).toBe('agent-x');
  });

  test('handles rejection comments too', () => {
    const db = new Database(':memory:');
    setupBaseline(db, TARGET);
    seed(db);
    insertAgent(db, 'agent-x', 'drafter');
    insertApprovalComment(db, 'c1', 'comment-1', 'drafter', 'rejection');

    applyMigration(db, TARGET);

    expect(getTargetAgentId(db, 'c1')).toBe('agent-x');
  });

  test('leaves comments with no matching agent untouched (no target_agent_id field)', () => {
    const db = new Database(':memory:');
    setupBaseline(db, TARGET);
    seed(db);
    insertApprovalComment(db, 'c1', 'comment-1', 'ghost-agent');

    applyMigration(db, TARGET);

    expect(getTargetAgentId(db, 'c1')).toBeNull();
    // Slug-form target_agent is preserved.
    expect(getFm(db, 'c1').target_agent).toBe('ghost-agent');
  });

  test('does not touch plain comments (kind=comment)', () => {
    const db = new Database(':memory:');
    setupBaseline(db, TARGET);
    seed(db);
    insertAgent(db, 'agent-x', 'drafter');
    // Plain comment, no target_agent field at all.
    db.run(
      `INSERT INTO documents (id, workspace_id, project_id, table_id, type, slug, title, body, frontmatter, created_by, updated_by, parent_id)
       VALUES ('c1', 'w1', 'p1', NULL, 'comment', 'plain', '', 'hi',
         json('${JSON.stringify({ author: 'user:u1', kind: 'comment', visibility: 'normal', mentions: [] })}'),
         'u1', 'u1', 'parent')`,
    );

    applyMigration(db, TARGET);

    const fm = getFm(db, 'c1');
    expect(fm.target_agent_id).toBeUndefined();
    expect(fm.target_agent).toBeUndefined();
  });

  test('is idempotent — second run is a no-op (target_agent_id already set)', () => {
    const db = new Database(':memory:');
    setupBaseline(db, TARGET);
    seed(db);
    insertAgent(db, 'agent-x', 'drafter');
    insertApprovalComment(db, 'c1', 'comment-1', 'drafter');

    applyMigration(db, TARGET);
    expect(getTargetAgentId(db, 'c1')).toBe('agent-x');

    // Re-run: no change.
    applyMigration(db, TARGET);
    expect(getTargetAgentId(db, 'c1')).toBe('agent-x');
  });

  test('does not cross workspaces', () => {
    const db = new Database(':memory:');
    setupBaseline(db, TARGET);
    seed(db);
    // Workspace B with its own agent of the same slug.
    db.run(`INSERT INTO workspaces (id, slug, name) VALUES ('w2', 'ws-b', 'WS-B')`);
    db.run(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ('w2', 'u1', 'owner')`);
    db.run(
      `INSERT INTO documents (id, workspace_id, project_id, table_id, type, slug, title, body, frontmatter, created_by, updated_by, parent_id)
       VALUES ('agent-other-ws', 'w2', NULL, NULL, 'agent', 'drafter', 'Agent', '',
         '{"system_prompt":"x","model":"m","provider":"anthropic","tools":[]}',
         'u1', 'u1', NULL)`,
    );
    // No matching agent in w1.
    insertApprovalComment(db, 'c1', 'comment-1', 'drafter');

    applyMigration(db, TARGET);

    expect(getTargetAgentId(db, 'c1')).toBeNull();
  });
});
