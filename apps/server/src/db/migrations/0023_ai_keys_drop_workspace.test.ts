import { describe, expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const MIGRATIONS_FOLDER = path.resolve(import.meta.dir);

function setup(): Database {
  const sqlite = new Database(':memory:');
  migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
  return sqlite;
}

describe('migration 0023 — ai_keys drops workspace_id', () => {
  test('after migration ai_keys has no workspace_id column + unique (provider,label)', () => {
    const sqlite = setup();
    const cols = (sqlite.query('PRAGMA table_info(ai_keys)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).not.toContain('workspace_id');
    // a NULL-workspace insert (no such column) + (provider,label) unique:
    sqlite.exec(
      `INSERT INTO ai_keys (id, provider, label, encrypted_key) VALUES ('k1','ollama','default','x')`,
    );
    expect(() =>
      sqlite.exec(
        `INSERT INTO ai_keys (id, provider, label, encrypted_key) VALUES ('k2','ollama','default','y')`,
      ),
    ).toThrow(); // unique (provider,label)
    // a different label for the same provider IS allowed:
    sqlite.exec(
      `INSERT INTO ai_keys (id, provider, label, encrypted_key) VALUES ('k3','ollama','cheap','z')`,
    );
  });

  test('FAIL LOUD: a pre-existing ai_keys row makes the migration abort (no silent resolve)', () => {
    // Exercise the guard the way drizzle's migrate() runs it: build the PRE-0023
    // ai_keys shape (with workspace_id), seed a row, then run 0023 STATEMENT-BY-
    // STATEMENT split on `--> statement-breakpoint` (migrate's exact semantics).
    // NOTE: a single sqlite.exec(wholeFile) does NOT exercise the guard —
    // bun:sqlite's .exec mishandles the `--> statement-breakpoint` comment markers
    // and silently no-ops the guard, giving a FALSE pass. Splitting first is what
    // proves the CHECK-constraint guard actually aborts on a non-empty table.
    const sqlite = new Database(':memory:');
    sqlite.exec(
      `CREATE TABLE ai_keys (id text PRIMARY KEY, workspace_id text NOT NULL, provider text NOT NULL, label text DEFAULT 'default' NOT NULL, encrypted_key text NOT NULL, base_url text, created_at integer)`,
    );
    sqlite.exec(
      `INSERT INTO ai_keys (id, workspace_id, provider, label, encrypted_key) VALUES ('pre','w','anthropic','default','z')`,
    );
    const sql = readFileSync(
      path.join(MIGRATIONS_FOLDER, '0023_ai_keys_drop_workspace.sql'),
      'utf8',
    );
    const statements = sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(() => {
      for (const stmt of statements) sqlite.exec(stmt);
    }).toThrow(/CHECK constraint failed/); // the guard aborts because a row exists
  });
});
