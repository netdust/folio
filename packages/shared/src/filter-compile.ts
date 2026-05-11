export type Operator = '$eq' | '$ne' | '$in' | '$nin' | '$gt' | '$gte' | '$lt' | '$lte' | '$exists';

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
  '$eq', '$ne', '$in', '$nin', '$gt', '$gte', '$lt', '$lte', '$exists',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function filterCompile(input: FilterInput): FilterAST {
  const clauses: FilterAST[] = [];
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
      clauses.push({ kind: 'cmp', key, op, value: value as JsonValue });
    }
  }
  return { kind: 'and', clauses };
}
