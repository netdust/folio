/**
 * 0008 — backfill comment authors from `agent:<slug>` to `agent:<id>` (G6).
 *
 * Establishes the new id-canonical form for all rows whose author resolves
 * against a CURRENTLY-LIVE agent. Rows that don't resolve (deleted agent or
 * mid-rename) are left alone; the application layer's slug back-compat path
 * can then be DROPPED — every row in the table is either id-canonical or
 * permanently un-editable via the author-only guard (intended: we don't want
 * a re-created agent inheriting old comments — the original review finding).
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
  // Parent work_item the comments hang off of.
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

function insertComment(db: Database, id: string, slug: string, author: string, createdAt?: number): void {
  const fm = JSON.stringify({
    author,
    kind: 'comment',
    visibility: 'normal',
    mentions: [],
  });
  const ts = createdAt ?? Date.now();
  db.run(
    `INSERT INTO documents (id, workspace_id, project_id, table_id, type, slug, title, body, frontmatter, created_by, updated_by, parent_id, created_at, updated_at)
     VALUES ('${id}', 'w1', 'p1', NULL, 'comment', '${slug}', '', 'hi',
       json('${fm}'),
       'u1', 'u1', 'parent', ${ts}, ${ts})`,
  );
}

function getAuthor(db: Database, commentId: string): string {
  const row = db
    .query(`SELECT json_extract(frontmatter, '$.author') AS a FROM documents WHERE id = ?`)
    .get(commentId) as { a: string };
  return row.a;
}

const TARGET = '0008_phase_2_6_author_id_backfill.sql';

describe('0008 author-id backfill migration', () => {
  test('rewrites agent:<slug> author to agent:<id> when slug resolves to a live agent', () => {
    const db = new Database(':memory:');
    setupBaseline(db, TARGET);
    seed(db);
    insertAgent(db, 'agent-x', 'drafter');
    insertComment(db, 'c1', 'comment-1', 'agent:drafter');

    applyMigration(db, TARGET);

    expect(getAuthor(db, 'c1')).toBe('agent:agent-x');
  });

  test('leaves user:<id> authors untouched', () => {
    const db = new Database(':memory:');
    setupBaseline(db, TARGET);
    seed(db);
    insertComment(db, 'c1', 'comment-1', 'user:u1');

    applyMigration(db, TARGET);

    expect(getAuthor(db, 'c1')).toBe('user:u1');
  });

  test('leaves agent:<unresolvable-slug> authors untouched (no matching agent)', () => {
    const db = new Database(':memory:');
    setupBaseline(db, TARGET);
    seed(db);
    insertComment(db, 'c1', 'comment-1', 'agent:ghost'); // no agent with slug 'ghost'

    applyMigration(db, TARGET);

    expect(getAuthor(db, 'c1')).toBe('agent:ghost');
  });

  test('is idempotent — re-running on already-id-canonical rows is a no-op', () => {
    const db = new Database(':memory:');
    setupBaseline(db, TARGET);
    seed(db);
    insertAgent(db, 'agent-x', 'drafter');
    // First migration writes id form.
    insertComment(db, 'c1', 'comment-1', 'agent:drafter');
    applyMigration(db, TARGET);
    expect(getAuthor(db, 'c1')).toBe('agent:agent-x');

    // Re-applying SHOULDN'T cascade — agent:agent-x's suffix is 'agent-x',
    // which is the agent's id, NOT a live agent's slug. So nothing matches.
    applyMigration(db, TARGET);
    expect(getAuthor(db, 'c1')).toBe('agent:agent-x');
  });

  test('does not cross workspaces — agent with same slug in workspace B does not affect workspace A comments', () => {
    const db = new Database(':memory:');
    setupBaseline(db, TARGET);
    seed(db);
    // Workspace B with its own agent of the same slug.
    db.run(`INSERT INTO workspaces (id, slug, name) VALUES ('w2', 'ws-b', 'WS-B')`);
    db.run(`INSERT INTO memberships (workspace_id, user_id, role) VALUES ('w2', 'u1', 'owner')`);
    db.run(
      `INSERT INTO documents (id, workspace_id, project_id, table_id, type, slug, title, body, frontmatter, created_by, updated_by, parent_id)
       VALUES ('agent-w2', 'w2', NULL, NULL, 'agent', 'drafter', 'Agent', '',
         '{"system_prompt":"x","model":"m","provider":"anthropic","tools":[]}',
         'u1', 'u1', NULL)`,
    );
    // Comment in workspace A referencing slug 'drafter' — there's no agent
    // with that slug in workspace A, so it should NOT pick up the workspace-B
    // agent's id.
    insertComment(db, 'c1', 'comment-1', 'agent:drafter');

    applyMigration(db, TARGET);

    expect(getAuthor(db, 'c1')).toBe('agent:drafter');
  });

  // H5 — temporal constraint. If the slug was DELETED then REUSED before
  // the migration ran, the new agent's id must NOT be backfilled into the
  // OLD comment. That'd bake in the very hijack the migration was meant
  // to prevent. Pre-upgrade timeline:
  //   - 2026-01-01: agent A (id=aaa, slug=drafter) writes comment c1
  //   - 2026-02-01: agent A is hard-deleted
  //   - 2026-03-01: agent B (id=bbb, slug=drafter) is created
  //   - 2026-04-01: migration 0008 runs
  // Before H5: c1's author rewritten to 'agent:bbb' — B can edit A's comment.
  // After H5: c1's author stays 'agent:drafter' — uneditable (B's createdAt
  // is LATER than c1's, so no temporal match exists).
  test('H5: leaves slug-form author untouched when the matching agent was created AFTER the comment (slug reuse)', () => {
    const db = new Database(':memory:');
    setupBaseline(db, TARGET);
    seed(db);

    // Comment created Jan 1.
    insertComment(db, 'c1', 'comment-1', 'agent:drafter', new Date('2026-01-01').getTime());

    // Agent B (with same slug) created Mar 1 — AFTER the comment.
    // No agent existed before c1's createdAt with this slug; the original
    // agent A was hard-deleted and isn't in the table anymore.
    insertAgent(db, 'agent-bbb', 'drafter', new Date('2026-03-01').getTime());

    applyMigration(db, TARGET);

    // Must stay slug-form — uneditable by anyone, that's the security
    // property after assertAuthor dropped its back-compat path.
    expect(getAuthor(db, 'c1')).toBe('agent:drafter');
  });

  test('H5: rewrites correctly when the matching agent IS older than the comment', () => {
    const db = new Database(':memory:');
    setupBaseline(db, TARGET);
    seed(db);

    // Agent created Jan 1.
    insertAgent(db, 'agent-ok', 'drafter', new Date('2026-01-01').getTime());
    // Comment created Feb 1 — AFTER the agent.
    insertComment(db, 'c1', 'comment-1', 'agent:drafter', new Date('2026-02-01').getTime());

    applyMigration(db, TARGET);

    expect(getAuthor(db, 'c1')).toBe('agent:agent-ok');
  });

  // H20 — non-comment rows must NOT be touched. work_item / page frontmatter
  // is free-form; an operator might legitimately store `author: agent:foo`
  // for unrelated reasons. The migration scopes `c.type = 'comment'` and
  // this test pins the scope so a future loosening regression fails CI.
  test('H20: leaves work_item rows with agent:<slug> in frontmatter untouched', () => {
    const db = new Database(':memory:');
    setupBaseline(db, TARGET);
    seed(db);
    insertAgent(db, 'agent-x', 'drafter');

    // Work_item with author='agent:drafter' in its free-form frontmatter.
    const fm = JSON.stringify({ author: 'agent:drafter', priority: 'high' });
    db.run(
      `INSERT INTO documents (id, workspace_id, project_id, table_id, type, slug, title, body, frontmatter, created_by, updated_by, parent_id)
       VALUES ('wi-1', 'w1', 'p1', 't1', 'work_item', 'wi-1', 'Task', '', json('${fm}'), 'u1', 'u1', NULL)`,
    );

    applyMigration(db, TARGET);

    const row = db
      .query(`SELECT json_extract(frontmatter, '$.author') AS a FROM documents WHERE id = 'wi-1'`)
      .get() as { a: string };
    expect(row.a).toBe('agent:drafter');
  });
});
