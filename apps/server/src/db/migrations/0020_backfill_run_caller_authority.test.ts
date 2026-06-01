import { describe, expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { agentRunFrontmatterSchema } from '@/lib/agent-run-schema';

const MIGRATIONS_FOLDER = path.resolve(import.meta.dir);

function readMigrationSql(): string {
  return readFileSync(
    path.join(MIGRATIONS_FOLDER, '0020_backfill_run_caller_authority.sql'),
    'utf8',
  );
}

/**
 * A full, valid agent_run frontmatter MINUS the two caller-authority keys —
 * exactly the shape of a row persisted before Phase 1 delegation shipped.
 */
function legacyRunFrontmatter(): Record<string, unknown> {
  return {
    assignee: 'agent:research-bot',
    status: 'completed',
    agent_slug: 'research-bot',
    provider: 'anthropic',
    model: 'claude-x',
    system_prompt: 'You are a research bot.',
    max_tokens: 4096,
    tokens_in: 10,
    tokens_out: 20,
    trigger_id: null,
    chain_id: '018f1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b',
    fired_by: 'token:abc',
    started_at: '2026-05-01T00:00:00.000Z',
  };
}

function seedRun(
  sqlite: Database,
  id: string,
  frontmatter: Record<string, unknown>,
): void {
  // agent_run rows have a CHECK requiring workspace_id + project_id + table_id
  // + parent_id (migration 0012). Satisfy it with the fixtures setup() seeds.
  sqlite.run(
    `INSERT INTO documents
     (id, workspace_id, project_id, table_id, parent_id,
      type, slug, title, body, frontmatter, created_at, updated_at)
     VALUES (?, 'w1', 'p1', 't1', 'parent1',
      'agent_run', ?, ?, '', ?, 0, 0)`,
    [id, id, id, JSON.stringify(frontmatter)],
  );
}

function readFrontmatter(sqlite: Database, id: string): Record<string, unknown> {
  const row = sqlite
    .prepare(`SELECT frontmatter FROM documents WHERE id = ?`)
    .get(id) as { frontmatter: string };
  return JSON.parse(row.frontmatter) as Record<string, unknown>;
}

function setup(): Database {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite);
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
     VALUES ('t1','p1','runs','Runs', 0)`,
  );
  sqlite.run(
    `INSERT INTO documents (id, project_id, workspace_id, table_id,
      type, slug, title, parent_id, created_at, updated_at)
     VALUES ('parent1','p1','w1','t1','work_item','parent','Parent', NULL, 0, 0)`,
  );
  return sqlite;
}

describe('migration 0020 — backfill run caller authority (D10)', () => {
  test('stamps fail-closed []/null on a legacy run lacking the keys, and it parses', () => {
    const sqlite = setup();
    seedRun(sqlite, 'run-legacy', legacyRunFrontmatter());

    // migrate() won't replay 0020 (journal idempotency) — exec the SQL directly.
    sqlite.exec(readMigrationSql());

    const fm = readFrontmatter(sqlite, 'run-legacy');
    expect(fm.caller_scopes).toEqual([]);
    expect(fm.caller_project_ids).toBeNull();

    // The end state must satisfy the required (strict) run schema.
    const parsed = agentRunFrontmatterSchema.parse(fm);
    expect(parsed.caller_scopes).toEqual([]);
    expect(parsed.caller_project_ids).toBeNull();
  });

  test('does NOT clobber a run that already has caller_scopes', () => {
    const sqlite = setup();
    const existing = {
      ...legacyRunFrontmatter(),
      caller_scopes: ['documents:read'],
      caller_project_ids: ['proj-1'],
    };
    seedRun(sqlite, 'run-existing', existing);

    sqlite.exec(readMigrationSql());

    const fm = readFrontmatter(sqlite, 'run-existing');
    expect(fm.caller_scopes).toEqual(['documents:read']);
    expect(fm.caller_project_ids).toEqual(['proj-1']);
  });

  test('does NOT touch non-agent_run documents', () => {
    const sqlite = setup();
    sqlite.run(
      `INSERT INTO documents
       (id, workspace_id, project_id, table_id, type, slug, title, body, frontmatter, created_at, updated_at)
       VALUES ('doc-1','w1','p1','t1','work_item','doc-1','Doc','', '{}', 0, 0)`,
    );

    sqlite.exec(readMigrationSql());

    const fm = readFrontmatter(sqlite, 'doc-1');
    expect(fm.caller_scopes).toBeUndefined();
    expect(fm.caller_project_ids).toBeUndefined();
  });

  test('is idempotent — a second exec is a no-op (existing snapshot preserved)', () => {
    const sqlite = setup();
    seedRun(sqlite, 'run-legacy', legacyRunFrontmatter());
    const existing = {
      ...legacyRunFrontmatter(),
      caller_scopes: ['documents:write'],
      caller_project_ids: null,
    };
    seedRun(sqlite, 'run-existing', existing);

    sqlite.exec(readMigrationSql());
    sqlite.exec(readMigrationSql());

    const legacy = readFrontmatter(sqlite, 'run-legacy');
    expect(legacy.caller_scopes).toEqual([]);
    expect(legacy.caller_project_ids).toBeNull();

    const preserved = readFrontmatter(sqlite, 'run-existing');
    expect(preserved.caller_scopes).toEqual(['documents:write']);
    expect(preserved.caller_project_ids).toBeNull();
  });
});
