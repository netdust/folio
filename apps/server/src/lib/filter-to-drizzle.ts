import type { FilterAST } from '@folio/shared';
import {
  and,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  sql,
} from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { documents } from '../db/schema.ts';

const COLUMN_KEYS = new Set(['type', 'status', 'title', 'slug', 'parent_id', 'parentId']);

function columnFor(key: string) {
  switch (key) {
    case 'type':
      return documents.type;
    case 'status':
      return documents.status;
    case 'title':
      return documents.title;
    case 'slug':
      return documents.slug;
    case 'parent_id':
    case 'parentId':
      return documents.parentId;
    default:
      return null;
  }
}

function fmExpr(key: string) {
  return sql`json_extract(${documents.frontmatter}, ${`$.${key}`})`;
}

function cmpToSql(key: string, op: string, value: unknown): SQL {
  const isColumn = COLUMN_KEYS.has(key);
  const lhs = isColumn ? columnFor(key)! : fmExpr(key);
  switch (op) {
    case '$eq':
      return eq(lhs as never, value as never);
    case '$ne':
      return ne(lhs as never, value as never);
    case '$gt':
      return gt(lhs as never, value as never);
    case '$gte':
      return gte(lhs as never, value as never);
    case '$lt':
      return lt(lhs as never, value as never);
    case '$lte':
      return lte(lhs as never, value as never);
    case '$in':
      return inArray(lhs as never, value as never[]);
    case '$nin':
      return notInArray(lhs as never, value as never[]);
    case '$exists':
      return (value as boolean) ? isNotNull(lhs as never) : isNull(lhs as never);
    case '$contains': {
      // Array-membership over a frontmatter JSON array (e.g. $.labels). Built-in
      // columns are scalars, not arrays, so $contains is meaningless on them.
      if (isColumn) {
        throw new Error(`$contains is not supported on built-in column "${key}"`);
      }
      // Normalize to an array (single value or list); AND each membership test.
      // Every value flows through Drizzle as a BOUND param (${v}) — never
      // interpolated — mirroring backlinks.ts's json_each EXISTS pattern.
      const values = Array.isArray(value) ? (value as unknown[]) : [value];
      const parts = values.map(
        (v) => sql`EXISTS (SELECT 1 FROM json_each(${fmExpr(key)}) WHERE value = ${v})` as SQL,
      );
      return and(...parts) as SQL;
    }
    default:
      throw new Error(`unhandled operator ${op}`);
  }
}

export function compileFilterToWhere(ast: FilterAST, _table: typeof documents): SQL | undefined {
  if (ast.kind === 'cmp') return cmpToSql(ast.key, ast.op, ast.value);
  if (ast.clauses.length === 0) return undefined;
  const parts = ast.clauses.map((c) => {
    if (c.kind === 'cmp') return cmpToSql(c.key, c.op, c.value);
    return compileFilterToWhere(c, documents);
  });
  return and(...(parts.filter(Boolean) as SQL[]));
}
