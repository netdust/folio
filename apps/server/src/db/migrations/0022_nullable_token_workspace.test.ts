import { describe, expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import path from 'node:path';

const MIGRATIONS_FOLDER = path.resolve(import.meta.dir);

function setup(): Database {
  const sqlite = new Database(':memory:');
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return sqlite;
}

describe('migration 0022 — api_tokens.workspace_id nullable (instance reach)', () => {
  test('0022: api_tokens.workspace_id accepts NULL (instance token)', () => {
    const sqlite = setup();
    sqlite.exec(`INSERT INTO api_tokens (id, workspace_id, name, token_hash, scopes, created_by)
                 VALUES ('t-inst', NULL, 'instance', 'hash-x', '[]', NULL)`);
    const row = sqlite
      .query("SELECT workspace_id FROM api_tokens WHERE id='t-inst'")
      .get() as { workspace_id: string | null };
    expect(row.workspace_id).toBeNull();
  });

  test('0022: a concrete workspace_id still inserts (back-compat)', () => {
    const sqlite = setup();
    sqlite.exec(`INSERT INTO workspaces (id, slug, name, created_at, updated_at)
                 VALUES ('w1','w1','W1',0,0)`);
    sqlite.exec(`INSERT INTO api_tokens (id, workspace_id, name, token_hash, scopes, created_by)
                 VALUES ('t-w1', 'w1', 'pinned', 'hash-y', '[]', NULL)`);
    const row = sqlite
      .query("SELECT workspace_id FROM api_tokens WHERE id='t-w1'")
      .get() as { workspace_id: string | null };
    expect(row.workspace_id).toBe('w1');
  });
});
