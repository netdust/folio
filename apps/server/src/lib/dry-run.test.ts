import { describe, expect, test } from 'bun:test';
import type { Context } from 'hono';
import { dryRunResult, isDryRun, isDryRunDelete } from './dry-run.ts';

function ctxWithQuery(value: string | undefined): Context {
  return { req: { query: (k: string) => (k === 'dryRun' ? value : undefined) } } as unknown as Context;
}

describe('dryRunResult', () => {
  test('wraps a resource with the dry_run envelope (P2-3)', () => {
    const row = { id: 'x', name: 'Tasks' };
    expect(dryRunResult('create', row)).toEqual({
      dry_run: true,
      would: 'create',
      resource: { id: 'x', name: 'Tasks' },
    });
  });

  test('resource is passed through verbatim — no redaction divergence', () => {
    const row = { id: 'y', name: 'Docs', icon: null, order: 3 };
    expect(dryRunResult('update', row).resource).toBe(row);
  });
});

describe('isDryRun', () => {
  test('true only when the validated json has dryRun === true', () => {
    expect(isDryRun({ dryRun: true })).toBe(true);
    expect(isDryRun({ dryRun: false })).toBe(false);
    expect(isDryRun({})).toBe(false);
    expect(isDryRun(undefined)).toBe(false);
  });
});

describe('isDryRunDelete', () => {
  test('true only when ?dryRun=true is present (single DELETE reader, P2-8)', () => {
    expect(isDryRunDelete(ctxWithQuery('true'))).toBe(true);
    expect(isDryRunDelete(ctxWithQuery('false'))).toBe(false);
    expect(isDryRunDelete(ctxWithQuery('1'))).toBe(false);
    expect(isDryRunDelete(ctxWithQuery(undefined))).toBe(false);
  });
});
