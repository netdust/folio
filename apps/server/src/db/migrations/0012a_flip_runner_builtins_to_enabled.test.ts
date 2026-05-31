import { describe, expect, test } from 'bun:test';
import Database from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const MIGRATIONS_FOLDER = path.resolve(import.meta.dir);

function readFlipSql(): string {
  return readFileSync(
    path.join(MIGRATIONS_FOLDER, '0012a_flip_runner_builtins_to_enabled.sql'),
    'utf8',
  );
}

describe('migration 0012a — flip runner builtins to enabled', () => {
  test('builtin-on-assignment + builtin-on-mention end at enabled=true', () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    sqlite.run(
      `INSERT INTO workspaces (id, slug, name, created_at, updated_at)
       VALUES ('w1','w1','W1', 0, 0)`,
    );
    // Seed pre-flip state: insert the two builtins with enabled=false, as a
    // 2.6-era workspace would have looked before A-3.
    for (const slug of ['builtin-on-assignment', 'builtin-on-mention']) {
      sqlite.run(
        `INSERT INTO documents
         (id, workspace_id, type, slug, title, frontmatter, created_at, updated_at)
         VALUES (?, 'w1','trigger', ?, ?, ?, 0, 0)`,
        [
          `id-${slug}`,
          slug,
          slug,
          JSON.stringify({ builtin: true, enabled: false }),
        ],
      );
    }

    // Now run the 0012a SQL against the seeded rows. (drizzle migrate() is
    // idempotent at the journal level — it won't replay 0012a, so we exec
    // the SQL directly to test the UPDATE against the seed.)
    sqlite.exec(readFlipSql());

    const rows = sqlite
      .prepare(
        `SELECT slug, frontmatter FROM documents WHERE workspace_id='w1' AND type='trigger'`,
      )
      .all() as Array<{ slug: string; frontmatter: string }>;

    expect(rows.length).toBe(2);
    for (const row of rows) {
      const fm = JSON.parse(row.frontmatter) as { enabled: boolean };
      expect(fm.enabled).toBe(true);
    }
  });

  test('does NOT touch other (non-runner) builtins or user triggers', () => {
    const sqlite = new Database(':memory:');
    const db = drizzle(sqlite);
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

    sqlite.run(
      `INSERT INTO workspaces (id, slug, name, created_at, updated_at)
       VALUES ('w1','w1','W1', 0, 0)`,
    );
    // Non-runner builtin (e.g. on-approval) already enabled — must stay enabled.
    sqlite.run(
      `INSERT INTO documents
       (id, workspace_id, type, slug, title, frontmatter, created_at, updated_at)
       VALUES ('id-x','w1','trigger','builtin-on-approval','x',?,0,0)`,
      [JSON.stringify({ builtin: true, enabled: true })],
    );
    // User custom trigger disabled — must stay disabled.
    sqlite.run(
      `INSERT INTO documents
       (id, workspace_id, type, slug, title, frontmatter, created_at, updated_at)
       VALUES ('id-y','w1','trigger','user-custom','y',?,0,0)`,
      [JSON.stringify({ builtin: false, enabled: false })],
    );

    sqlite.exec(readFlipSql());

    const x = sqlite
      .prepare(`SELECT frontmatter FROM documents WHERE id='id-x'`)
      .get() as { frontmatter: string };
    const y = sqlite
      .prepare(`SELECT frontmatter FROM documents WHERE id='id-y'`)
      .get() as { frontmatter: string };

    expect((JSON.parse(x.frontmatter) as { enabled: boolean }).enabled).toBe(true);
    expect((JSON.parse(y.frontmatter) as { enabled: boolean }).enabled).toBe(false);
  });
});
