/**
 * Group-summary request validator — the untrusted-spec parsing layer for the
 * `GET .../documents/group-summary` endpoint. This is the parsing→SQL trust
 * boundary, the SAME class as `filterCompile` (which shipped a CRITICAL before
 * its whitelist/cap landed). Built by mirroring `filter-compile.ts` EXACTLY.
 *
 * Threat-model mitigations (see the plan's `## Threat model — group-summary
 * endpoint`):
 *  1. Closed `AGGREGATIONS` whitelist (shared) — unknown op → INVALID_AGGREGATE.
 *  2. Field-key regex `/^[a-zA-Z0-9_]+$/` here; the registered-`fields`-row half
 *     is enforced in the service (it has the DB).
 *  3. MAX_AGGREGATES cap.
 *  4. MAX_GROUPS top-N cap (applied in the service query).
 *  8. MAX_DISTRIBUTION_BUCKETS cap (applied in the service query).
 *
 * Errors are thrown as `HTTPError` (NOT a custom class) so the existing
 * `registerErrorHandler` serializer maps them to the ONE structured error shape.
 */

import { AGGREGATIONS, type AggregateSpec, type Aggregation } from '@folio/shared';
import { HTTPError } from './http.ts';

/** The `MAX_FILTER_CLAUSES` analogue — bounds aggregate-expression fan-out (mitigation 3). */
export const MAX_AGGREGATES = 10;

/** Top-N group cap — the service ORDER BYs count DESC and detects >this (mitigation 4). */
export const MAX_GROUPS = 200;

/** Distinct buckets per group in a `distribution` aggregate; the rest fold to "other" (mitigation 8). */
export const MAX_DISTRIBUTION_BUCKETS = 50;

/** The canonical frontmatter/built-in field-key shape (documents.ts line ~99). */
const FIELD_KEY_RE = /^[a-zA-Z0-9_]+$/;

/** Built-in document columns accepted as a groupBy/field without a `fields` row (mitigation 2). */
export const BUILTIN_FIELD_KEYS = new Set(['status', 'title', 'type']);

const AGGREGATION_SET = new Set<Aggregation>(AGGREGATIONS);

/** Ops that require an aggregate `field`. */
const FIELD_REQUIRED = new Set<Aggregation>(['avg', 'sum', 'distribution', 'pct_matching']);

export interface GroupSummaryRequestInput {
  groupBy: unknown;
  aggregates: unknown;
  filter?: unknown;
}

export interface ValidatedGroupSummaryRequest {
  groupBy: string;
  aggregates: AggregateSpec[];
}

function isValidFieldKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && FIELD_KEY_RE.test(key);
}

/**
 * Validate the STRUCTURAL shape of a client group-summary spec: the op
 * whitelist, the aggregate cap, the field-key regex, and per-op required
 * field/value presence. Returns the normalized request. Throws `HTTPError`
 * (422) with `INVALID_GROUP_BY` (bad key) or `INVALID_AGGREGATE` (bad op /
 * too many / missing required field|value).
 *
 * The second half of mitigation 2 — that each validated key is also a
 * *registered* `fields` row (or a built-in) — needs the DB and is enforced in
 * the service.
 */
export function validateGroupSummaryRequest(
  input: GroupSummaryRequestInput,
): ValidatedGroupSummaryRequest {
  // --- groupBy key ---
  if (!isValidFieldKey(input.groupBy)) {
    throw new HTTPError(
      'INVALID_GROUP_BY',
      'INVALID_GROUP_BY: groupBy must be a non-empty field key matching /^[a-zA-Z0-9_]+$/',
      422,
    );
  }

  // --- aggregates array + cap (mitigation 3) ---
  if (!Array.isArray(input.aggregates)) {
    throw new HTTPError('INVALID_AGGREGATE', 'INVALID_AGGREGATE: aggregates must be an array', 422);
  }
  if (input.aggregates.length === 0) {
    throw new HTTPError(
      'INVALID_AGGREGATE',
      'INVALID_AGGREGATE: aggregates must contain at least one spec',
      422,
    );
  }
  if (input.aggregates.length > MAX_AGGREGATES) {
    throw new HTTPError(
      'INVALID_AGGREGATE',
      `INVALID_AGGREGATE: at most ${MAX_AGGREGATES} aggregates (got ${input.aggregates.length})`,
      422,
    );
  }

  const aggregates: AggregateSpec[] = [];
  for (const raw of input.aggregates) {
    if (typeof raw !== 'object' || raw === null) {
      throw new HTTPError(
        'INVALID_AGGREGATE',
        'INVALID_AGGREGATE: each aggregate must be an object',
        422,
      );
    }
    const spec = raw as { op?: unknown; field?: unknown; value?: unknown };

    // --- op whitelist (mitigation 1) — NO op string ever reaches SQL un-mapped ---
    if (typeof spec.op !== 'string' || !AGGREGATION_SET.has(spec.op as Aggregation)) {
      throw new HTTPError(
        'INVALID_AGGREGATE',
        `INVALID_AGGREGATE: unknown aggregation op "${String(spec.op)}"`,
        422,
      );
    }
    const op = spec.op as Aggregation;

    // --- required field for avg/sum/distribution/pct_matching (mitigation 2 regex too) ---
    let field: string | undefined;
    if (FIELD_REQUIRED.has(op)) {
      if (!isValidFieldKey(spec.field)) {
        // A bad field key is a key-shape failure → INVALID_GROUP_BY (mitigation 2),
        // but a MISSING field on an op that needs one is a spec error → INVALID_AGGREGATE.
        if (spec.field === undefined || spec.field === null) {
          throw new HTTPError(
            'INVALID_AGGREGATE',
            `INVALID_AGGREGATE: op "${op}" requires a field`,
            422,
          );
        }
        throw new HTTPError(
          'INVALID_GROUP_BY',
          `INVALID_GROUP_BY: aggregate field must match /^[a-zA-Z0-9_]+$/ (op "${op}")`,
          422,
        );
      }
      field = spec.field;
    }

    // --- pct_matching requires a value; it flows to SQL as a BOUND param (mitigation 2) ---
    let value: string | undefined;
    if (op === 'pct_matching') {
      if (typeof spec.value !== 'string' || spec.value.length === 0) {
        throw new HTTPError(
          'INVALID_AGGREGATE',
          'INVALID_AGGREGATE: op "pct_matching" requires a non-empty value',
          422,
        );
      }
      value = spec.value;
    }

    aggregates.push({ op, ...(field ? { field } : {}), ...(value !== undefined ? { value } : {}) });
  }

  return { groupBy: input.groupBy, aggregates };
}

/** Re-export so the service can validate keys against the same regex/built-ins. */
export { isValidFieldKey };
