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

  test('ai_usage metering table is created (T2 — record-only usage)', () => {
    const sqlite = setup();
    const tbl = sqlite
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_usage'")
      .get() as { name: string } | null;
    expect(tbl?.name).toBe('ai_usage');
    sqlite.exec(
      `INSERT INTO ai_usage (id, workspace_id, run_id, provider, label, tokens_in, tokens_out)
       VALUES ('u1','w','r','ollama','default',10,5)`,
    );
    const row = sqlite
      .query("SELECT tokens_in, tokens_out FROM ai_usage WHERE id='u1'")
      .get() as { tokens_in: number; tokens_out: number };
    expect(row.tokens_in).toBe(10);
    expect(row.tokens_out).toBe(5);
  });

  test('FAIL LOUD: a pre-existing ai_keys row makes the migration abort (no silent resolve)', () => {
    // Full chain → 0023 already applied on the empty table: OK. Then seed a row and
    // re-exec the 0023 SQL directly to prove the guard SQL aborts on a non-empty table.
    const sqlite = setup();
    sqlite.exec(
      `INSERT INTO ai_keys (id, provider, label, encrypted_key) VALUES ('pre','anthropic','default','z')`,
    );
    const sql = readFileSync(
      path.join(MIGRATIONS_FOLDER, '0023_ai_keys_drop_workspace.sql'),
      'utf8',
    );
    expect(() => sqlite.exec(sql)).toThrow(); // guard aborts because a row exists
  });
});
