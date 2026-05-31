import { test, expect } from 'bun:test';
import path from 'node:path';
import {
  ALWAYS_KEEP_INDEXES,
  scanFileForDrift,
  scanMigrationsDir,
} from './check-migration-drift.ts';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'src', 'db', 'migrations');

test('the actual migrations directory contains zero drift', () => {
  const issues = scanMigrationsDir(MIGRATIONS_DIR);
  if (issues.length > 0) {
    // Friendly error so the failing path is obvious.
    const lines = issues.map(
      (i) => `  ${i.file}:${i.line} drops "${i.indexName}" — ${i.rawStatement}`,
    );
    throw new Error(
      `Migration drift detected — these statements would drop always-keep indexes:\n${lines.join('\n')}`,
    );
  }
  expect(issues.length).toBe(0);
});

test('scanFileForDrift catches a synthetic DROP INDEX against an allow-list name', () => {
  const synthetic =
    `-- A fake auto-generated migration\n` +
    `DROP INDEX documents_runs_pending_idx;\n` +
    `CREATE INDEX something_else ON documents(id);\n`;
  const issues = scanFileForDrift('synthetic.sql', synthetic);
  expect(issues.length).toBe(1);
  expect(issues[0]!.indexName).toBe('documents_runs_pending_idx');
  expect(issues[0]!.line).toBe(2);
});

test('scanFileForDrift catches DROP INDEX IF EXISTS form too', () => {
  const synthetic = `DROP INDEX IF EXISTS \`documents_runs_by_chain_idx\`;\n`;
  const issues = scanFileForDrift('synthetic.sql', synthetic);
  expect(issues.length).toBe(1);
  expect(issues[0]!.indexName).toBe('documents_runs_by_chain_idx');
});

test('scanFileForDrift ignores DROP INDEX against names NOT on the allow-list', () => {
  const synthetic = `DROP INDEX some_unrelated_index;\n`;
  const issues = scanFileForDrift('synthetic.sql', synthetic);
  expect(issues.length).toBe(0);
});

test('ALWAYS_KEEP_INDEXES contains the 5 partial indexes we documented in F15', () => {
  expect(ALWAYS_KEEP_INDEXES).toContain('documents_comments_idx');
  expect(ALWAYS_KEEP_INDEXES).toContain('documents_runs_by_parent_idx');
  expect(ALWAYS_KEEP_INDEXES).toContain('documents_runs_by_status_idx');
  expect(ALWAYS_KEEP_INDEXES).toContain('documents_runs_pending_idx');
  expect(ALWAYS_KEEP_INDEXES).toContain('documents_runs_by_chain_idx');
});
