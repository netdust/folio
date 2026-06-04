import { describe, expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const MIGRATIONS_FOLDER = path.resolve(import.meta.dir);

/**
 * The real `migrate()` splits a multi-statement migration on the drizzle
 * `--> statement-breakpoint` marker. `bun:sqlite`'s `exec(wholeFile)` does NOT
 * split, so a multi-statement file run via `exec` would try to run the whole
 * blob and the statement after the marker would silently no-op. Split manually
 * to mirror what the deploy-time migrator does.
 */
function execMigrationByStatements(sqlite: Database): void {
  const sql = readFileSync(
    path.join(MIGRATIONS_FOLDER, '0026_backfill_roles_and_access.sql'),
    'utf8',
  );
  for (const stmt of sql.split('--> statement-breakpoint')) {
    const s = stmt.trim();
    if (s) sqlite.exec(s);
  }
}

/**
 * Seeds OLD-model rows: a reserved `__system` workspace + a normal `galleries`
 * workspace, three users (role defaults to 'member'), and the workspace-scoped
 * `memberships` rows the backfill must translate.
 *
 *   sys   — owner of __system          → instance owner, NO access grant
 *   bob   — owner of galleries ONLY    → instance MEMBER  + galleries grant
 *   carol — admin of galleries         → instance MEMBER  + galleries grant
 *
 * `migrate()` will NOT replay 0026 (journal idempotency) — the caller execs the
 * backfill SQL directly against these seeded rows.
 */
function setup(): Database {
  const sqlite = new Database(':memory:');
  migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });

  sqlite.run(
    `INSERT INTO workspaces (id, slug, name, created_at, updated_at)
     VALUES ('sysws','__system','System', 0, 0),
            ('galls','galleries','Galleries', 0, 0)`,
  );
  // role omitted -> defaults to 'member' (the pre-backfill state).
  sqlite.run(
    `INSERT INTO users (id, email, name, created_at)
     VALUES ('sys','sys@t','Sys', 0),
            ('bob','bob@t','Bob', 0),
            ('carol','carol@t','Carol', 0)`,
  );
  sqlite.run(
    `INSERT INTO memberships (workspace_id, user_id, role, created_at)
     VALUES ('sysws','sys','owner', 0),
            ('galls','bob','owner', 0),
            ('galls','carol','admin', 0)`,
  );
  return sqlite;
}

function role(sqlite: Database, email: string): string {
  return (
    sqlite.prepare(`SELECT role FROM users WHERE email = ?`).get(email) as {
      role: string;
    }
  ).role;
}

function grant(sqlite: Database, email: string, slug: string): unknown {
  return sqlite
    .prepare(
      `SELECT 1 FROM workspace_access wa
       JOIN workspaces w ON w.id = wa.workspace_id
       JOIN users u ON u.id = wa.user_id
       WHERE u.email = ? AND w.slug = ?`,
    )
    .get(email, slug);
}

describe('migration 0026 — backfill roles + access from memberships (T-F)', () => {
  test('per-workspace owner/admin does NOT become instance owner/admin; only __system membership does', () => {
    const sqlite = setup();
    execMigrationByStatements(sqlite);

    // T-F guard: folder authority must NOT escalate to instance authority.
    expect(role(sqlite, 'bob@t')).toBe('member'); // galleries owner -> instance MEMBER
    expect(role(sqlite, 'carol@t')).toBe('member'); // galleries admin -> instance MEMBER
    expect(role(sqlite, 'sys@t')).toBe('owner'); // __system owner -> instance OWNER

    // Folder authority became an explicit access grant…
    expect(grant(sqlite, 'bob@t', 'galleries')).toBeTruthy();
    expect(grant(sqlite, 'carol@t', 'galleries')).toBeTruthy();
    // …but the __system membership did NOT (it only conveyed instance authority,
    // now on users.role; __system is deleted in a later task).
    expect(grant(sqlite, 'sys@t', '__system')).toBeFalsy();

    sqlite.close();
  });

  test('a user with BOTH a __system role AND a per-ws membership gets the __system role + a grant for the per-ws one', () => {
    const sqlite = setup();
    // dave is admin of __system (instance authority) AND a member of galleries.
    sqlite.run(
      `INSERT INTO users (id, email, name, created_at)
       VALUES ('dave','dave@t','Dave', 0)`,
    );
    sqlite.run(
      `INSERT INTO memberships (workspace_id, user_id, role, created_at)
       VALUES ('sysws','dave','admin', 0),
              ('galls','dave','member', 0)`,
    );

    execMigrationByStatements(sqlite);

    expect(role(sqlite, 'dave@t')).toBe('admin'); // role sourced from __system
    expect(grant(sqlite, 'dave@t', 'galleries')).toBeTruthy(); // per-ws -> grant
    expect(grant(sqlite, 'dave@t', '__system')).toBeFalsy(); // __system -> no grant

    sqlite.close();
  });

  test('is idempotent — a second run preserves roles + grants (no duplicate-PK error)', () => {
    const sqlite = setup();
    execMigrationByStatements(sqlite);
    // Second run must not throw (workspace_access PK collision) and must be inert.
    execMigrationByStatements(sqlite);

    expect(role(sqlite, 'bob@t')).toBe('member');
    expect(role(sqlite, 'sys@t')).toBe('owner');
    expect(grant(sqlite, 'bob@t', 'galleries')).toBeTruthy();
    expect(grant(sqlite, 'sys@t', '__system')).toBeFalsy();

    const count = (
      sqlite
        .prepare(
          `SELECT COUNT(*) AS c FROM workspace_access wa
           JOIN users u ON u.id = wa.user_id WHERE u.email = 'bob@t'`,
        )
        .get() as { c: number }
    ).c;
    expect(count).toBe(1);

    sqlite.close();
  });
});
