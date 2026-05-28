/**
 * Migration drift guard (R10 fix, post-review-of-review).
 *
 * Scans every .sql migration file under `apps/server/src/db/migrations/`
 * for `DROP INDEX <name>` statements against an allow-list of indexes
 * that MUST NEVER be dropped — typically partial indexes and
 * expression-indexed columns that Drizzle's schema builder cannot
 * model, so a future `bun --filter=server db:generate` could emit a
 * spurious DROP against them.
 *
 * Wired into the unit test suite (`scripts/check-migration-drift.test.ts`)
 * so a generated migration that accidentally drops one of these
 * surfaces at `bun test` time, not at production migration time.
 *
 * To add a new always-keep index name, append to `ALWAYS_KEEP_INDEXES`.
 * The list is intentionally append-only — a removal would mean the
 * index is genuinely no longer needed AND every workspace has had a
 * deploy that drops it.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Partial / expression indexes that live in raw-SQL migrations and
 * CANNOT be declared in schema.ts. Drizzle's schema differ may emit
 * `DROP INDEX <name>` against them on the next generate; that emit
 * must be caught and reverted manually.
 */
export const ALWAYS_KEEP_INDEXES: readonly string[] = [
  // Phase 2.6 — comments hot path (partial on type='comment')
  'documents_comments_idx',
  // Phase 3 — agent_run reads (4 partial indexes from migration 0012)
  'documents_runs_by_parent_idx',
  'documents_runs_by_status_idx',
  'documents_runs_pending_idx',
  'documents_runs_by_chain_idx',
];

export interface DriftIssue {
  file: string;
  line: number;
  indexName: string;
  rawStatement: string;
}

/**
 * Scan a single .sql file for DROP INDEX statements targeting any of
 * the always-keep names. Returns one issue per match.
 */
export function scanFileForDrift(
  filePath: string,
  fileContents: string,
): DriftIssue[] {
  const issues: DriftIssue[] = [];
  const lines = fileContents.split('\n');
  const dropRe = /^\s*DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?`?([a-zA-Z0-9_]+)`?/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = line.match(dropRe);
    if (!match) continue;
    const indexName = match[1]!;
    if (ALWAYS_KEEP_INDEXES.includes(indexName)) {
      issues.push({
        file: filePath,
        line: i + 1,
        indexName,
        rawStatement: line.trim(),
      });
    }
  }
  return issues;
}

/**
 * Scan all `.sql` files in `migrationsDir` and return any drift issues.
 * Used by both the CLI runner below and the unit test.
 */
export function scanMigrationsDir(migrationsDir: string): DriftIssue[] {
  const entries = readdirSync(migrationsDir, { withFileTypes: true });
  const issues: DriftIssue[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.sql')) continue;
    const full = path.join(migrationsDir, entry.name);
    const contents = readFileSync(full, 'utf8');
    issues.push(...scanFileForDrift(entry.name, contents));
  }
  return issues;
}

// CLI runner — invoked via `bun apps/server/scripts/check-migration-drift.ts`.
// Exits 1 on any drift; 0 otherwise. Suitable for pre-migrate / pre-commit hooks.
if (import.meta.main) {
  const migrationsDir = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '..',
    'src',
    'db',
    'migrations',
  );
  const issues = scanMigrationsDir(migrationsDir);
  if (issues.length === 0) {
    // eslint-disable-next-line no-console
    console.log('migration drift check: OK');
    process.exit(0);
  }
  // eslint-disable-next-line no-console
  console.error('migration drift check: FAILED');
  for (const issue of issues) {
    // eslint-disable-next-line no-console
    console.error(
      `  ${issue.file}:${issue.line} drops always-keep index "${issue.indexName}"\n    ${issue.rawStatement}`,
    );
  }
  process.exit(1);
}
