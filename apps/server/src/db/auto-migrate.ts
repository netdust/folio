import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import path from 'node:path';
import type { DB } from './client.ts';

// Why: dev DBs routinely fall behind on migrations when pulling a branch.
// Symptom is route 500s with cryptic SQL errors. Skipped in NODE_ENV=test
// because the test harness owns migration against fresh in-memory DBs.
// See ~/.claude/projects/-home-ntdst-Projects-folio/memory/feedback_migrations-first-when-routes-look-broken.md
export function runMigrationsOnBoot(db: DB): void {
  if (process.env.NODE_ENV === 'test') return;
  const migrationsFolder = path.join(import.meta.dir, 'migrations');
  migrate(db, { migrationsFolder });
}
