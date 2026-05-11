import {
  and, eq, ne, gt, gte, lt, lte, inArray, notInArray, isNull, isNotNull, sql,
} from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { FilterAST } from '@folio/shared';
import { documents } from '../db/schema.ts';

const COLUMN_KEYS = new Set(['type', 'status', 'title', 'slug', 'parent_id', 'parentId']);

function columnFor(key: string) {
  switch (key) {
    case 'type': return documents.type;
    case 'status': return documents.status;
    case 'title': return documents.title;
    case 'slug': return documents.slug;
    case 'parent_id':
    case 'parentId': return documents.parentId;
    default: return null;
  }
}

function fmExpr(key: string) {
  return sql`json_extract(${documents.frontmatter}, ${'$.' + key})`;
}

function cmpToSql(key: string, op: string, value: unknown): SQL {
  const isColumn = COLUMN_KEYS.has(key);
  const lhs = isColumn ? columnFor(key)! : fmExpr(key);
  switch (op) {
    case '$eq':  return eq(lhs as never, value as never);
    case '$ne':  return ne(lhs as never, value as never);
    case '$gt':  return gt(lhs as never, value as never);
    case '$gte': return gte(lhs as never, value as never);
    case '$lt':  return lt(lhs as never, value as never);
    case '$lte': return lte(lhs as never, value as never);
    case '$in':  return inArray(lhs as never, value as never[]);
    case '$nin': return notInArray(lhs as never, value as never[]);
    case '$exists':
      return (value as boolean) ? isNotNull(lhs as never) : isNull(lhs as never);
    default: throw new Error(`unhandled operator ${op}`);
  }
}

export function compileFilterToWhere(
  ast: FilterAST,
  _table: typeof documents,
): SQL | undefined {
  if (ast.kind === 'cmp') return cmpToSql(ast.key, ast.op, ast.value);
  if (ast.clauses.length === 0) return undefined;
  const parts = ast.clauses.map((c) => {
    if (c.kind === 'cmp') return cmpToSql(c.key, c.op, c.value);
    return compileFilterToWhere(c, documents);
  });
  return and(...(parts.filter(Boolean) as SQL[]));
}
