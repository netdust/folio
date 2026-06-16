/**
 * The group-summary aggregate engine — compiles a VALIDATED client spec
 * (groupBy + aggregates + filter) into a `GROUP BY json_extract(...)` query
 * over the FULL filtered, project-scoped document set.
 *
 * This is the parsing→SQL surface (the M3 `$contains` trust-boundary class).
 * The validation/whitelist/caps live in `lib/group-summary.ts`; this module
 * adds the DB-bound half: the registered-`fields`-row check (mitigation 2,
 * second half), project scope (mitigation 6), filter reuse (mitigation 5), the
 * full-set (no-page) aggregate (mitigation 7), the top-N group cap (mitigation
 * 4), and the distribution distinct-bucket cap (mitigation 8).
 *
 * SQL-injection posture (mitigation 1/2): the op never reaches SQL un-mapped —
 * each whitelisted op maps to a FIXED `sql` fragment. Field keys are
 * regex-validated AND matched to a registered field/built-in, then interpolated
 * ONLY into a `'$.<key>'` json path (the proven `fieldSortExpr`/`fmExpr`
 * pattern). The `pct_matching` match VALUE flows as a BOUND param (`${value}`).
 */

import {
  type AggregateSpec,
  type DistributionBucket,
  FilterCompileError,
  type GroupSummaryResponse,
  type GroupSummaryRow,
  filterCompile,
} from '@folio/shared';
import { type SQL, and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { documents, fields } from '../db/schema.ts';
import { compileFilterToWhere } from '../lib/filter-to-drizzle.ts';
import {
  BUILTIN_FIELD_KEYS,
  MAX_DISTRIBUTION_BUCKETS,
  MAX_GROUPS,
  validateGroupSummaryRequest,
} from '../lib/group-summary.ts';
import { HTTPError } from '../lib/http.ts';

export interface GroupSummaryArgs {
  projectId: string;
  /** When set, scope work_items to this table (mirrors listDocuments). */
  activeTableId?: string | null;
  groupBy: string;
  aggregates: AggregateSpec[];
  /** Already-parsed filter JSON (same FilterInput shape as GET /documents), or undefined. */
  filter?: unknown;
  /** Document type to aggregate (defaults to work_item). */
  type?: string;
}

function builtinCol(key: string): SQL {
  switch (key) {
    case 'status':
      return sql`${documents.status}`;
    case 'title':
      return sql`${documents.title}`;
    case 'type':
      return sql`${documents.type}`;
    default:
      // Unreachable: keys are pre-validated against BUILTIN_FIELD_KEYS.
      throw new HTTPError('INVALID_GROUP_BY', `INVALID_GROUP_BY: unknown built-in "${key}"`, 422);
  }
}

/**
 * The SQL expression for a field key. Built-ins resolve to their column; a
 * registered frontmatter key resolves to `json_extract(frontmatter, '$.<key>')`.
 * The key is regex-validated AND registered, so the path interpolation is safe
 * (the documents.ts fieldSortExpr pattern).
 */
function fieldExpr(key: string): SQL {
  if (BUILTIN_FIELD_KEYS.has(key)) return builtinCol(key);
  return sql`json_extract(${documents.frontmatter}, ${`$.${key}`})`;
}

/** The stable response key for an aggregate spec. */
function specKey(spec: AggregateSpec): string {
  switch (spec.op) {
    case 'count':
      return 'count';
    case 'pct_matching':
      return `pct_matching:${spec.field}:${spec.value}`;
    default:
      return `${spec.op}:${spec.field}`;
  }
}

/**
 * The fixed SQL SELECT fragment for one aggregate op (mitigation 1). `distribution`
 * is NOT computed here — it runs as a second GROUP BY g,v query (see below) — so
 * this returns null for it.
 */
function aggregateFragment(spec: AggregateSpec, alias: string): SQL | null {
  switch (spec.op) {
    case 'count':
      return sql`COUNT(*) AS ${sql.raw(alias)}`;
    case 'pct_matching': {
      const fe = fieldExpr(spec.field!);
      // The match value is a BOUND param — never interpolated (mitigation 2).
      return sql`(COUNT(CASE WHEN ${fe} = ${spec.value} THEN 1 END) * 100.0 / COUNT(*)) AS ${sql.raw(alias)}`;
    }
    case 'avg':
      return sql`AVG(CAST(${fieldExpr(spec.field!)} AS REAL)) AS ${sql.raw(alias)}`;
    case 'sum':
      return sql`SUM(CAST(${fieldExpr(spec.field!)} AS REAL)) AS ${sql.raw(alias)}`;
    case 'distribution':
      return null;
    default: {
      // Defense in depth: a non-whitelisted op must never reach here.
      throw new HTTPError(
        'INVALID_AGGREGATE',
        `INVALID_AGGREGATE: unmapped op "${(spec as AggregateSpec).op}"`,
        422,
      );
    }
  }
}

/**
 * Collect every field key the spec references (groupBy + each aggregate field)
 * and assert each is a registered `fields` row for the project OR a built-in
 * (mitigation 2, second half). Throws INVALID_GROUP_BY for an unregistered key.
 */
async function assertFieldsRegistered(
  projectId: string,
  groupBy: string,
  aggregates: AggregateSpec[],
): Promise<void> {
  const needed = new Set<string>();
  if (!BUILTIN_FIELD_KEYS.has(groupBy)) needed.add(groupBy);
  for (const a of aggregates) {
    if (a.field && !BUILTIN_FIELD_KEYS.has(a.field)) needed.add(a.field);
  }
  if (needed.size === 0) return;

  const rows = await db
    .select({ key: fields.key })
    .from(fields)
    .where(eq(fields.projectId, projectId));
  const registered = new Set(rows.map((r) => r.key));
  for (const key of needed) {
    if (!registered.has(key)) {
      throw new HTTPError(
        'INVALID_GROUP_BY',
        `INVALID_GROUP_BY: "${key}" is not a registered field or a built-in column`,
        422,
      );
    }
  }
}

/** Build the base WHERE (project scope + type + table scope + filter). */
function buildWhere(args: GroupSummaryArgs): SQL {
  const type = args.type ?? 'work_item';
  const clauses: SQL[] = [
    eq(documents.projectId, args.projectId) as SQL, // mitigation 6 — ALWAYS present
    eq(documents.type, type as never) as SQL,
  ];
  // Work_items scope to the active table like listDocuments does.
  if (type === 'work_item' && args.activeTableId) {
    clauses.push(eq(documents.tableId, args.activeTableId) as SQL);
  }
  // Filter reuse (mitigation 5) — compile through the SHARED compiler + caps.
  if (args.filter !== undefined && args.filter !== null) {
    try {
      const ast = filterCompile(args.filter as Parameters<typeof filterCompile>[0]);
      const where = compileFilterToWhere(ast, documents);
      if (where) clauses.push(where);
    } catch (e) {
      if (e instanceof FilterCompileError) {
        throw new HTTPError('INVALID_FILTER', `INVALID_FILTER: ${e.message}`, 422);
      }
      throw e;
    }
  }
  return and(...clauses) as SQL;
}

/**
 * Compute per-group aggregates over the FULL filtered, project-scoped set.
 * Returns the documented `GroupSummaryResponse` shape.
 */
export async function groupSummary(args: GroupSummaryArgs): Promise<GroupSummaryResponse> {
  // 1. Structural validation (whitelist, caps, key regex) — throws 422.
  const { groupBy, aggregates } = validateGroupSummaryRequest({
    groupBy: args.groupBy,
    aggregates: args.aggregates,
  });
  // 2. Registered-field check (DB half of mitigation 2).
  await assertFieldsRegistered(args.projectId, groupBy, aggregates);

  const where = buildWhere(args);
  const groupExpr = fieldExpr(groupBy);

  // 3. The aggregate SELECT list. `count` is always present; each spec gets a
  //    deterministic alias agg0..aggN. `distribution` is deferred to a 2nd query.
  const aliasFor = (i: number) => `agg${i}`;
  const selectFrags: SQL[] = [sql`COUNT(*) AS g_count`];
  const scalarSpecs: { spec: AggregateSpec; alias: string }[] = [];
  const distributionSpecs: AggregateSpec[] = [];
  aggregates.forEach((spec, i) => {
    if (spec.op === 'distribution') {
      distributionSpecs.push(spec);
      return;
    }
    const alias = aliasFor(i);
    const frag = aggregateFragment(spec, alias);
    if (frag) {
      selectFrags.push(frag);
      scalarSpecs.push({ spec, alias });
    }
  });

  // 4. The grouped query over the FULL set (mitigation 7 — NO limit/cursor on
  //    rows). Only NON-null/empty groups; the ungrouped bucket is a separate
  //    query. Top-N cap +1 to detect truncation (mitigation 4).
  const selectList = sql.join([sql`${groupExpr} AS g`, ...selectFrags], sql`, `);
  // Perf: relies on `documents_project_type_idx ON (project_id, type)` (schema.ts)
  // to narrow the scan to this project+type slice BEFORE the unindexed
  // `json_extract` groupExpr. Keep that index if a future db:generate touches it.
  const groupRows = await db.all<Record<string, unknown>>(sql`
    SELECT ${selectList}
      FROM ${documents}
     WHERE ${where} AND ${groupExpr} IS NOT NULL AND ${groupExpr} <> ''
     GROUP BY g
     ORDER BY g_count DESC
     LIMIT ${MAX_GROUPS + 1}
  `);

  const truncated = groupRows.length > MAX_GROUPS;
  const keptRows = truncated ? groupRows.slice(0, MAX_GROUPS) : groupRows;

  // 5. Distribution sub-counts (mitigation 8) — one GROUP BY g,v per dist field,
  //    folded per group with a MAX_DISTRIBUTION_BUCKETS cap + "other".
  const distByGroup = new Map<string, Map<string, DistributionBucket[]>>();
  for (const spec of distributionSpecs) {
    const ve = fieldExpr(spec.field!);
    // NB: no `${groupExpr} IS NOT NULL AND <> ''` exclusion here — the ungrouped
    // (null/empty groupBy) rows MUST be included so they fold under the literal
    // 'null' group key (`String(r.g) === 'null'`), which the ungrouped assembly
    // (buildRow with `g: null`) then resolves. Excluding them silently emptied
    // the ungrouped bucket's distribution.
    const distRows = await db.all<{ g: string | null; v: string | null; c: number }>(sql`
      SELECT ${groupExpr} AS g, ${ve} AS v, COUNT(*) AS c
        FROM ${documents}
       WHERE ${where}
       GROUP BY g, v
       ORDER BY g, c DESC
    `);
    const perGroup = new Map<string, { value: string; count: number }[]>();
    for (const r of distRows) {
      const gKey = String(r.g);
      const list = perGroup.get(gKey) ?? [];
      list.push({ value: r.v === null ? '' : String(r.v), count: r.c });
      perGroup.set(gKey, list);
    }
    const folded = new Map<string, DistributionBucket[]>();
    for (const [gKey, list] of perGroup) {
      // list is already ordered count DESC within the group.
      const head = list.slice(0, MAX_DISTRIBUTION_BUCKETS);
      const tail = list.slice(MAX_DISTRIBUTION_BUCKETS);
      const buckets: DistributionBucket[] = head;
      if (tail.length > 0) {
        const otherCount = tail.reduce((s, b) => s + b.count, 0);
        buckets.push({ value: 'other', count: otherCount });
      }
      folded.set(gKey, buckets);
    }
    distByGroup.set(specKey(spec), folded);
  }

  // 6. Assemble the response rows.
  const buildRow = (raw: Record<string, unknown>): GroupSummaryRow => {
    const value = raw.g === null || raw.g === undefined ? null : String(raw.g);
    const aggMap: Record<string, number | DistributionBucket[]> = {};
    for (const { spec, alias } of scalarSpecs) {
      aggMap[specKey(spec)] = Number(raw[alias] ?? 0);
    }
    for (const spec of distributionSpecs) {
      const key = specKey(spec);
      aggMap[key] = distByGroup.get(key)?.get(String(raw.g)) ?? [];
    }
    return { value, count: Number(raw.g_count ?? 0), aggregates: aggMap };
  };

  const groups = keptRows.map(buildRow);

  // 7. The ungrouped bucket — documents whose groupBy field is missing/empty.
  const ungroupedRows = await db.all<Record<string, unknown>>(sql`
    SELECT ${selectList}
      FROM ${documents}
     WHERE ${where} AND (${groupExpr} IS NULL OR ${groupExpr} = '')
  `);
  // The aggregate query always returns one row (COUNT over zero rows = 0); the
  // bucket is real only when it actually holds documents.
  const ungroupedRaw = ungroupedRows[0];
  let ungrouped: GroupSummaryRow | null = null;
  if (ungroupedRaw && Number(ungroupedRaw.g_count ?? 0) > 0) {
    // buildRow with `g: null` resolves the ungrouped distribution via the literal
    // 'null' group key (`String(null) === 'null'`), which the dist sub-query now
    // populates — no separate re-loop needed.
    ungrouped = buildRow({ ...ungroupedRaw, g: null });
  }

  return { groups, ungrouped, truncated };
}
