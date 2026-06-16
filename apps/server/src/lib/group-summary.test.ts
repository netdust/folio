/**
 * Unit tests for the group-summary validator (the parsing→SQL trust boundary).
 *
 * Tier A: this is the untrusted-spec validator — the same class as
 * `filterCompile`. Every denial path is mandatory (the whitelist, the caps, the
 * field-key regex). Mitigations 1–4, 8 from the plan's `## Threat model —
 * group-summary endpoint`.
 *
 * The validator does the STRUCTURAL validation (whitelist + caps + key regex +
 * required-field presence); the registered-`fields`-row check (mitigation 2,
 * second half) needs the DB and is exercised in `services/group-summary.test.ts`.
 */

import { expect, test } from 'bun:test';
import {
  MAX_AGGREGATES,
  MAX_DISTRIBUTION_BUCKETS,
  MAX_GROUPS,
  validateGroupSummaryRequest,
} from './group-summary.ts';
import { HTTPError } from './http.ts';

test('accepts a valid spec and returns the normalized request', () => {
  const req = validateGroupSummaryRequest({
    groupBy: 'status',
    aggregates: [
      { op: 'count' },
      { op: 'pct_matching', field: 'att', value: 'done' },
      { op: 'avg', field: 'att' },
    ],
  });
  expect(req.groupBy).toBe('status');
  expect(req.aggregates).toHaveLength(3);
});

test('rejects an unknown aggregation op (422 INVALID_AGGREGATE)', () => {
  expect(() =>
    validateGroupSummaryRequest({ groupBy: 'status', aggregates: [{ op: 'evil' as never }] }),
  ).toThrow(/INVALID_AGGREGATE|unknown aggregation/);
});

test('the thrown error is a 422 HTTPError with the INVALID_AGGREGATE code', () => {
  try {
    validateGroupSummaryRequest({ groupBy: 'status', aggregates: [{ op: 'evil' as never }] });
    throw new Error('should have thrown');
  } catch (e) {
    expect(e).toBeInstanceOf(HTTPError);
    expect((e as HTTPError).code).toBe('INVALID_AGGREGATE');
    expect((e as HTTPError).status).toBe(422);
  }
});

test('rejects more than MAX_AGGREGATES aggregates (422)', () => {
  const aggregates = Array.from({ length: MAX_AGGREGATES + 1 }, () => ({ op: 'count' as const }));
  expect(() => validateGroupSummaryRequest({ groupBy: 'status', aggregates })).toThrow(
    /INVALID_AGGREGATE/,
  );
});

test('accepts exactly MAX_AGGREGATES aggregates', () => {
  const aggregates = Array.from({ length: MAX_AGGREGATES }, () => ({ op: 'count' as const }));
  expect(() => validateGroupSummaryRequest({ groupBy: 'status', aggregates })).not.toThrow();
});

test('rejects a groupBy key failing /^[a-zA-Z0-9_]+$/ (422 INVALID_GROUP_BY)', () => {
  expect(() =>
    validateGroupSummaryRequest({ groupBy: "x'); DROP", aggregates: [{ op: 'count' }] }),
  ).toThrow(/INVALID_GROUP_BY/);
});

test('rejects an empty groupBy key (422 INVALID_GROUP_BY)', () => {
  expect(() => validateGroupSummaryRequest({ groupBy: '', aggregates: [{ op: 'count' }] })).toThrow(
    /INVALID_GROUP_BY/,
  );
});

test('rejects an aggregate field key failing the regex (422 INVALID_GROUP_BY)', () => {
  expect(() =>
    validateGroupSummaryRequest({
      groupBy: 'status',
      aggregates: [{ op: 'avg', field: "att'); DROP" }],
    }),
  ).toThrow(/INVALID_GROUP_BY/);
});

test('rejects avg/sum/distribution without a field (422 INVALID_AGGREGATE)', () => {
  for (const op of ['avg', 'sum', 'distribution'] as const) {
    expect(() => validateGroupSummaryRequest({ groupBy: 'status', aggregates: [{ op }] })).toThrow(
      /INVALID_AGGREGATE/,
    );
  }
});

test('rejects pct_matching without a value (422 INVALID_AGGREGATE)', () => {
  expect(() =>
    validateGroupSummaryRequest({
      groupBy: 'status',
      aggregates: [{ op: 'pct_matching', field: 'att' }],
    }),
  ).toThrow(/INVALID_AGGREGATE/);
});

test('rejects pct_matching without a field (422 INVALID_AGGREGATE)', () => {
  expect(() =>
    validateGroupSummaryRequest({
      groupBy: 'status',
      aggregates: [{ op: 'pct_matching', value: 'done' }],
    }),
  ).toThrow(/INVALID_AGGREGATE/);
});

test('rejects an empty aggregates array (422 — a summary with no stats is meaningless)', () => {
  expect(() => validateGroupSummaryRequest({ groupBy: 'status', aggregates: [] })).toThrow(
    /INVALID_AGGREGATE/,
  );
});

test('caps are sane defaults (mitigations 3/4/8)', () => {
  expect(MAX_AGGREGATES).toBe(10);
  expect(MAX_GROUPS).toBe(200);
  expect(MAX_DISTRIBUTION_BUCKETS).toBe(50);
});
