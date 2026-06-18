import Database from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';

const MIGRATIONS_FOLDER = path.resolve(import.meta.dir);

describe('migration 0039 — fields.type CHECK widened to accept image', () => {
  test('after the full migration chain, an image field is INSERTable (CHECK accepts it)', () => {
    const sqlite = new Database(':memory:');
    migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS_FOLDER });
    // Minimal parent rows for the FKs.
    sqlite.exec(
      `INSERT INTO projects (id, workspace_id, slug, name) VALUES ('p1','w1','proj','Proj')`,
    );
    sqlite.exec(
      `INSERT INTO tables (id, project_id, slug, name) VALUES ('t1','p1','work-items','WI')`,
    );
    // The CHECK must now accept 'image' (pre-0039 it threw SQLITE_CONSTRAINT_CHECK).
    expect(() =>
      sqlite.exec(
        `INSERT INTO fields (id, project_id, table_id, key, type) VALUES ('f1','p1','t1','cover','image')`,
      ),
    ).not.toThrow();
    // A bogus type is STILL rejected by the widened CHECK (the constraint didn't go permissive).
    expect(() =>
      sqlite.exec(
        `INSERT INTO fields (id, project_id, table_id, key, type) VALUES ('f2','p1','t1','bad','bogus')`,
      ),
    ).toThrow();
  });

  // The 0039 table-REBUILD (DROP + recreate) must preserve every existing field row.
  // A rebuild that silently lost rows would pass an empty-table test — so seed a
  // NON-EMPTY pre-0039 `fields` table (the 13-type CHECK from 0019), apply 0039
  // statement-by-statement (split on `--> statement-breakpoint`; bun:sqlite's .exec
  // mishandles the markers as one blob), and assert all rows survive.
  test('REBUILD-SAFE: pre-existing field rows of every prior type survive the rebuild', () => {
    const sqlite = new Database(':memory:');
    // Pre-0039 fields shape: the 0019 CHECK (13 types, no 'image').
    sqlite.exec(
      `CREATE TABLE fields (
        id text PRIMARY KEY NOT NULL,
        project_id text NOT NULL,
        table_id text NOT NULL,
        key text NOT NULL,
        type text NOT NULL CHECK (type IN ('string','text','number','boolean','date','datetime','select','multi_select','user_ref','url','document_ref','currency','relation')),
        label text,
        options text,
        "order" integer DEFAULT 0 NOT NULL
      )`,
    );
    sqlite.exec('CREATE UNIQUE INDEX fields_table_key_idx ON fields (table_id, key)');
    sqlite.exec(
      `INSERT INTO fields (id, project_id, table_id, key, type, label, "order") VALUES
        ('a','p1','t1','title','string','Title',0),
        ('b','p1','t1','priority','select','Priority',10),
        ('c','p1','t1','homepage','url','Homepage',20),
        ('d','p1','t2','cost','currency','Cost',0)`,
    );
    const statements = readFileSync(
      path.join(MIGRATIONS_FOLDER, '0039_image_field_type.sql'),
      'utf8',
    )
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of statements) sqlite.exec(stmt);

    const rows = sqlite
      .query('SELECT id, key, type, label, "order" FROM fields ORDER BY id')
      .all() as { id: string; key: string; type: string; label: string | null; order: number }[];
    expect(rows).toEqual([
      { id: 'a', key: 'title', type: 'string', label: 'Title', order: 0 },
      { id: 'b', key: 'priority', type: 'select', label: 'Priority', order: 10 },
      { id: 'c', key: 'homepage', type: 'url', label: 'Homepage', order: 20 },
      { id: 'd', key: 'cost', type: 'currency', label: 'Cost', order: 0 },
    ]);
    // The unique index survived the rebuild (a dup (table_id,key) is rejected).
    expect(() =>
      sqlite.exec(
        `INSERT INTO fields (id, project_id, table_id, key, type) VALUES ('dup','p1','t1','title','text')`,
      ),
    ).toThrow();
    // And the widened CHECK now accepts 'image' on the rebuilt table.
    expect(() =>
      sqlite.exec(
        `INSERT INTO fields (id, project_id, table_id, key, type) VALUES ('img','p1','t1','cover','image')`,
      ),
    ).not.toThrow();
  });
});
