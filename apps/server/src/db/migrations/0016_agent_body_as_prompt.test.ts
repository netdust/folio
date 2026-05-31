import { describe, expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const MIGRATIONS_FOLDER = path.resolve(import.meta.dir);

function readMigrationSql(): string {
  return readFileSync(
    path.join(MIGRATIONS_FOLDER, '0016_agent_body_as_prompt.sql'),
    'utf8',
  );
}

function seedAgent(
  sqlite: Database,
  id: string,
  body: string,
  frontmatter: Record<string, unknown>,
): void {
  sqlite.run(
    `INSERT INTO documents
     (id, workspace_id, type, slug, title, body, frontmatter, created_at, updated_at)
     VALUES (?, 'w1', 'agent', ?, ?, ?, ?, 0, 0)`,
    [id, id, id, body, JSON.stringify(frontmatter)],
  );
}

function readAgent(
  sqlite: Database,
  id: string,
): { body: string; frontmatter: string } {
  return sqlite
    .prepare(`SELECT body, frontmatter FROM documents WHERE id = ?`)
    .get(id) as { body: string; frontmatter: string };
}

describe('migration 0016 — agent system_prompt -> body', () => {
  test('backfills body from system_prompt when body empty, then strips the key', () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    sqlite.run(
      `INSERT INTO workspaces (id, slug, name, created_at, updated_at)
       VALUES ('w1','w1','W1', 0, 0)`,
    );
    seedAgent(sqlite, 'agent-empty', '', { system_prompt: 'You are A.', model: 'x' });

    // migrate() won't replay 0016 (journal idempotency) — exec the SQL directly.
    sqlite.exec(readMigrationSql());

    const row = readAgent(sqlite, 'agent-empty');
    const fm = JSON.parse(row.frontmatter) as Record<string, unknown>;
    expect(row.body).toBe('You are A.');
    expect(fm.system_prompt).toBeUndefined();
    // Other frontmatter keys are preserved.
    expect(fm.model).toBe('x');
  });

  test('does NOT clobber an existing body, but still strips the legacy key', () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    sqlite.run(
      `INSERT INTO workspaces (id, slug, name, created_at, updated_at)
       VALUES ('w1','w1','W1', 0, 0)`,
    );
    seedAgent(sqlite, 'agent-present', 'EXISTING BODY', {
      system_prompt: 'You are B.',
    });

    sqlite.exec(readMigrationSql());

    const row = readAgent(sqlite, 'agent-present');
    const fm = JSON.parse(row.frontmatter) as Record<string, unknown>;
    expect(row.body).toBe('EXISTING BODY');
    expect(fm.system_prompt).toBeUndefined();
  });

  test('is idempotent — a second exec is a no-op', () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    sqlite.run(
      `INSERT INTO workspaces (id, slug, name, created_at, updated_at)
       VALUES ('w1','w1','W1', 0, 0)`,
    );
    seedAgent(sqlite, 'agent-empty', '', { system_prompt: 'You are A.' });
    seedAgent(sqlite, 'agent-present', 'EXISTING BODY', {
      system_prompt: 'You are B.',
    });

    sqlite.exec(readMigrationSql());
    sqlite.exec(readMigrationSql());

    const empty = readAgent(sqlite, 'agent-empty');
    const present = readAgent(sqlite, 'agent-present');
    expect(empty.body).toBe('You are A.');
    expect(present.body).toBe('EXISTING BODY');
    expect((JSON.parse(empty.frontmatter) as Record<string, unknown>).system_prompt).toBeUndefined();
    expect(
      (JSON.parse(present.frontmatter) as Record<string, unknown>).system_prompt,
    ).toBeUndefined();
  });
});
