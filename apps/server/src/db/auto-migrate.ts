import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
// Static top-level import: `bun build --compile` embeds the `with { type: 'file' }`
// imports inside this manifest because the import graph (index.ts -> auto-migrate.ts
// -> build-manifest.ts) is static. In dev the committed stub exports empty records
// and the on-disk fallback below runs instead. See scripts/build-manifest.ts.
import { JOURNAL_PATH, MIGRATIONS } from '../../../../scripts/build-manifest.ts';
import type { DB } from './client.ts';

// Why: dev DBs routinely fall behind on migrations when pulling a branch.
// Symptom is route 500s with cryptic SQL errors. Skipped in NODE_ENV=test
// because the test harness owns migration against fresh in-memory DBs.
// See ~/.claude/projects/-home-ntdst-Projects-folio/memory/feedback_migrations-first-when-routes-look-broken.md
export function runMigrationsOnBoot(db: DB): void {
  if (process.env.NODE_ENV === 'test') return;

  // Compiled single binary: the migrations dir is a $bunfs virtual path with no
  // .sql files on disk, so drizzle's migrate() (which reads a real FOLDER) would
  // silently no-op. Materialize the embedded sql + journal into a temp dir and
  // point migrate() at that. The journal MUST be present or migrate() skips every
  // file (repo lesson: drizzle-migration-journal). Bun.embeddedFiles is [] when
  // NOT compiled, so length > 0 is a sound "am I a compiled binary?" discriminator.
  if (Bun.embeddedFiles.length > 0) {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'folio-migrations-'));
    mkdirSync(path.join(tmpDir, 'meta'), { recursive: true });
    // The journal drives which <tag>.sql files drizzle reads; write it first.
    writeFileSync(path.join(tmpDir, 'meta', '_journal.json'), readFileSync(JOURNAL_PATH));
    for (const [name, embeddedPath] of Object.entries(MIGRATIONS)) {
      writeFileSync(path.join(tmpDir, name), readFileSync(embeddedPath));
    }
    migrate(db, { migrationsFolder: tmpDir });
    return;
  }

  // Dev / uncompiled: the .sql files are on disk next to this module.
  const migrationsFolder = path.join(import.meta.dir, 'migrations');
  migrate(db, { migrationsFolder });
}
