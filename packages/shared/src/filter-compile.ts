export type Operator =
  | '$eq'
  | '$ne'
  | '$in'
  | '$nin'
  | '$gt'
  | '$gte'
  | '$lt'
  | '$lte'
  | '$exists'
  | '$contains';

/** Max number of values in a `$contains` array — bounds the EXISTS subquery fan-out (DoS guard). */
const CONTAINS_MAX_VALUES = 100;

/**
 * Max number of top-level clauses (keys) in one filter. CONTAINS_MAX_VALUES caps
 * fan-out PER clause; without a clause cap an attacker stacks unbounded keys
 * ({k0..k499:{$contains:[100 vals]}}) → 50k EXISTS subqueries in one query →
 * CPU DoS. This caps the product.
 */
const MAX_FILTER_CLAUSES = 50;

/**
 * Built-in document columns. `$contains` is array-membership over a frontmatter
 * JSON array; these are scalar columns, so `$contains` on them is meaningless —
 * reject at compile time (one validation layer) so it surfaces as a 422, not a
 * downstream SQL error → 500.
 */
const COLUMN_KEYS = new Set(['type', 'status', 'title', 'slug', 'parent_id', 'parentId']);

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export type FilterAST =
  | { kind: 'and'; clauses: FilterAST[] }
  | { kind: 'cmp'; key: string; op: Operator; value: JsonValue };

export type FilterInput = Record<string, JsonValue | Partial<Record<Operator, JsonValue>>>;

export class FilterCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilterCompileError';
  }
}

const OPERATORS = new Set<Operator>([
  '$eq',
  '$ne',
  '$in',
  '$nin',
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$exists',
  '$contains',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function filterCompile(input: FilterInput): FilterAST {
  const clauses: FilterAST[] = [];
  if (Object.keys(input).length > MAX_FILTER_CLAUSES) {
    throw new FilterCompileError(
      `filter accepts at most ${MAX_FILTER_CLAUSES} keys (got ${Object.keys(input).length})`,
    );
  }
  for (const [key, raw] of Object.entries(input)) {
    if (raw === null || !isPlainObject(raw)) {
      clauses.push({ kind: 'cmp', key, op: '$eq', value: raw as JsonValue });
      continue;
    }
    const entries = Object.entries(raw);
    if (entries.length === 0) {
      throw new FilterCompileError(`empty operator object for key "${key}"`);
    }
    for (const [opKey, value] of entries) {
      if (!OPERATORS.has(opKey as Operator)) {
        throw new FilterCompileError(`unknown operator "${opKey}" for key "${key}"`);
      }
      const op = opKey as Operator;
      if ((op === '$in' || op === '$nin') && !Array.isArray(value)) {
        throw new FilterCompileError(`${op} requires an array for key "${key}"`);
      }
      if (op === '$exists' && typeof value !== 'boolean') {
        throw new FilterCompileError(`$exists requires a boolean for key "${key}"`);
      }
      if (op === '$contains') {
        if (COLUMN_KEYS.has(key)) {
          throw new FilterCompileError(
            `$contains is not supported on built-in column "${key}" (columns are scalars, not arrays)`,
          );
        }
        const values = Array.isArray(value) ? value : [value];
        if (values.length === 0) {
          throw new FilterCompileError(`$contains requires at least one value for key "${key}"`);
        }
        if (values.length > CONTAINS_MAX_VALUES) {
          throw new FilterCompileError(
            `$contains accepts at most ${CONTAINS_MAX_VALUES} values for key "${key}"`,
          );
        }
        if (!values.every((v) => typeof v === 'string')) {
          throw new FilterCompileError(
            `$contains requires a string or an array of strings for key "${key}"`,
          );
        }
      }
      clauses.push({ kind: 'cmp', key, op, value: value as JsonValue });
    }
  }
  return { kind: 'and', clauses };
}
