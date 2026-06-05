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

  // Exercise 0023 against a NON-EMPTY pre-0023 table the way drizzle's migrate()
  // runs it: build the PRE-0023 ai_keys shape (with workspace_id) by hand, seed
  // rows, then apply 0023 STATEMENT-BY-STATEMENT split on `--> statement-breakpoint`
  // (migrate's exact semantics — the full migrator can't be used because it runs
  // every migration in one shot, leaving no window to seed pre-0023 data).
  // NOTE: a single sqlite.exec(wholeFile) does NOT run the statements correctly —
  // bun:sqlite's .exec mishandles the `--> statement-breakpoint` markers. Splitting
  // first is what reproduces the real per-statement upgrade path.
  function applyPre0023AndMigrate(seed: (db: Database) => void): Database {
    const sqlite = new Database(':memory:');
    sqlite.exec(
      `CREATE TABLE ai_keys (id text PRIMARY KEY, workspace_id text NOT NULL, provider text NOT NULL, label text DEFAULT 'default' NOT NULL, encrypted_key text NOT NULL, base_url text, created_at integer)`,
    );
    seed(sqlite);
    const sql = readFileSync(
      path.join(MIGRATIONS_FOLDER, '0023_ai_keys_drop_workspace.sql'),
      'utf8',
    );
    const statements = sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) sqlite.exec(stmt);
    return sqlite;
  }

  test('UPGRADE-SAFE: pre-existing keys migrate forward (no abort), workspace_id dropped', () => {
    // Two workspaces, three keys: distinct (provider,label) pairs all survive.
    const sqlite = applyPre0023AndMigrate((db) => {
      db.exec(
        `INSERT INTO ai_keys (id, workspace_id, provider, label, encrypted_key, created_at) VALUES
          ('a','w1','anthropic','default','enc-a',100),
          ('b','w1','ollama','default','enc-b',200),
          ('c','w2','anthropic','cheap','enc-c',300)`,
      );
    });
    const cols = (sqlite.query('PRAGMA table_info(ai_keys)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).not.toContain('workspace_id');
    const rows = sqlite
      .query('SELECT id, provider, label, encrypted_key FROM ai_keys ORDER BY id')
      .all() as { id: string; provider: string; label: string; encrypted_key: string }[];
    expect(rows).toEqual([
      { id: 'a', provider: 'anthropic', label: 'default', encrypted_key: 'enc-a' },
      { id: 'b', provider: 'ollama', label: 'default', encrypted_key: 'enc-b' },
      { id: 'c', provider: 'anthropic', label: 'cheap', encrypted_key: 'enc-c' },
    ]);
  });

  test('DEDUP: cross-workspace (provider,label) duplicates collapse to the NEWEST by created_at', () => {
    // Same (anthropic, default) configured in two workspaces — the new unique
    // index forbids both. Keep the most-recently-created; drop the older.
    const sqlite = applyPre0023AndMigrate((db) => {
      db.exec(
        `INSERT INTO ai_keys (id, workspace_id, provider, label, encrypted_key, created_at) VALUES
          ('old','w1','anthropic','default','stale-key',100),
          ('new','w2','anthropic','default','fresh-key',500),
          ('keep','w1','ollama','default','ollama-key',300)`,
      );
    });
    const rows = sqlite
      .query('SELECT id, provider, label, encrypted_key FROM ai_keys ORDER BY id')
      .all() as { id: string; provider: string; label: string; encrypted_key: string }[];
    expect(rows).toEqual([
      { id: 'keep', provider: 'ollama', label: 'default', encrypted_key: 'ollama-key' },
      { id: 'new', provider: 'anthropic', label: 'default', encrypted_key: 'fresh-key' },
    ]);
    // The surviving anthropic/default row is the newer one — no stale credential wins.
    const winner = sqlite
      .query(`SELECT encrypted_key FROM ai_keys WHERE provider='anthropic' AND label='default'`)
      .get() as { encrypted_key: string };
    expect(winner.encrypted_key).toBe('fresh-key');
  });

  test('DEDUP TIE-BREAK: equal created_at collapses deterministically (max id wins)', () => {
    const sqlite = applyPre0023AndMigrate((db) => {
      db.exec(
        `INSERT INTO ai_keys (id, workspace_id, provider, label, encrypted_key, created_at) VALUES
          ('aaa','w1','openai','default','first',100),
          ('zzz','w2','openai','default','second',100)`,
      );
    });
    const rows = sqlite.query('SELECT id FROM ai_keys').all() as { id: string }[];
    expect(rows).toEqual([{ id: 'zzz' }]); // ORDER BY created_at DESC, id DESC → 'zzz'
  });
});
