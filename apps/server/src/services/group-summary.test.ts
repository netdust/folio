/**
 * Service-level tests for the group-summary aggregate engine (bun:sqlite, real
 * DB — mirrors documents.test.ts / documents.sort.test.ts setup).
 *
 * Tier A: parsing→SQL boundary + a cost/injection guard + a data-correctness
 * contract (the FULL-tier surface). The load-bearing test is the 247-rows
 * full-set correctness (the page-2-bug class — the whole reason the endpoint
 * exists). Every denial path (whitelist, caps, injection-safe bound value,
 * project scope, registered-field check) is asserted.
 *
 * Threat-model mitigations 1–8.
 */

import { expect, test } from 'bun:test';
import type { DistributionBucket } from '@folio/shared';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { documents, fields, projects, tables } from '../db/schema.ts';
import { HTTPError } from '../lib/http.ts';
import { makeTestApp } from '../test/harness.ts';
import { groupSummary } from './group-summary.ts';

async function getWorkItemsTable(
  db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  projectId: string,
) {
  const t = await db.query.tables.findFirst({
    where: and(eq(tables.projectId, projectId), eq(tables.slug, 'work-items')),
  });
  if (!t) throw new Error('test setup: work-items table missing');
  return t;
}

/** Register a frontmatter field so the registered-field check (mitigation 2) accepts it. */
async function registerField(
  db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  projectId: string,
  tableId: string,
  key: string,
  type: 'number' | 'string' | 'select' = 'number',
) {
  await db.insert(fields).values({ id: nanoid(), projectId, tableId, key, type });
}

/** Seed N work_items via a frontmatter/status factory. */
async function seedWorkItems(
  db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  projectId: string,
  workspaceId: string,
  tableId: string,
  n: number,
  factory: (i: number) => { status: string; fm: Record<string, unknown> },
) {
  const rows = Array.from({ length: n }, (_, i) => {
    const { status, fm } = factory(i);
    return {
      id: nanoid(),
      projectId,
      workspaceId,
      tableId,
      type: 'work_item' as const,
      slug: `wi-${i}-${nanoid(6)}`,
      title: `WI ${i}`,
      status,
      body: '',
      frontmatter: fm,
    };
  });
  // Insert in chunks to stay under SQLite's variable limit.
  for (let i = 0; i < rows.length; i += 100) {
    await db.insert(documents).values(rows.slice(i, i + 100));
  }
}

// ---------- the load-bearing correctness test (mitigation 7) ----------

test('aggregates over the FULL set across pages, not a page (247 rows)', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  await registerField(db, seed.project.id, table.id, 'att', 'number');
  // 148 done, 99 open; att = 90 + (i % 11) (mean is deterministic).
  await seedWorkItems(db, seed.project.id, seed.workspace.id, table.id, 247, (i) => ({
    status: i < 148 ? 'done' : 'open',
    fm: { att: 90 + (i % 11) },
  }));

  const { groups } = await groupSummary({
    projectId: seed.project.id,
    activeTableId: table.id,
    groupBy: 'status',
    aggregates: [
      { op: 'count' },
      { op: 'pct_matching', field: 'status', value: 'done' },
      { op: 'avg', field: 'att' },
    ],
  });

  const done = groups.find((g) => g.value === 'done')!;
  const open = groups.find((g) => g.value === 'open')!;
  // Full set — NOT a page-1 (50-row) subset.
  expect(done.count).toBe(148);
  expect(open.count).toBe(99);
  // 100% of the `done` group matches status==='done'.
  expect(done.aggregates['pct_matching:status:done']).toBe(100);
  expect(open.aggregates['pct_matching:status:done']).toBe(0);
  // avg(att) is a real number in the seeded band [90, 100].
  expect(done.aggregates['avg:att'] as number).toBeGreaterThanOrEqual(90);
  expect(done.aggregates['avg:att'] as number).toBeLessThanOrEqual(100);
});

test('sum aggregates over the full set', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  await registerField(db, seed.project.id, table.id, 'pts', 'number');
  // 10 docs, all status 'open', each pts=2 → sum=20.
  await seedWorkItems(db, seed.project.id, seed.workspace.id, table.id, 10, () => ({
    status: 'open',
    fm: { pts: 2 },
  }));
  const { groups } = await groupSummary({
    projectId: seed.project.id,
    activeTableId: table.id,
    groupBy: 'status',
    aggregates: [{ op: 'sum', field: 'pts' }],
  });
  expect(groups.find((g) => g.value === 'open')!.aggregates['sum:pts']).toBe(20);
});

// ---------- injection-safety (mitigation 2) ----------

test('pct_matching value flows as a BOUND param — an injection string matches literally (zero), not all rows', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  await registerField(db, seed.project.id, table.id, 'owner', 'string');
  await seedWorkItems(db, seed.project.id, seed.workspace.id, table.id, 20, () => ({
    status: 'open',
    fm: { owner: 'alice' },
  }));
  const { groups } = await groupSummary({
    projectId: seed.project.id,
    activeTableId: table.id,
    groupBy: 'status',
    // A classic SQLi payload as the match VALUE — it must be treated as a literal.
    aggregates: [{ op: 'pct_matching', field: 'owner', value: "x' OR '1'='1" }],
  });
  const open = groups.find((g) => g.value === 'open')!;
  // No owner equals the literal payload → 0%, NOT 100% (which a broken bind would give).
  expect(open.count).toBe(20);
  expect(open.aggregates["pct_matching:owner:x' OR '1'='1"]).toBe(0);
});

// ---------- whitelist + caps denials (mitigations 1/3) ----------

test('rejects an unknown op (422 INVALID_AGGREGATE)', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  await expect(
    groupSummary({
      projectId: seed.project.id,
      activeTableId: table.id,
      groupBy: 'status',
      aggregates: [{ op: 'evil' as never }],
    }),
  ).rejects.toThrow(/INVALID_AGGREGATE/);
});

test('rejects a groupBy key that is neither a registered field nor a built-in (422 INVALID_GROUP_BY)', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  // `nonsense` passes the regex but is not registered and not a built-in.
  await expect(
    groupSummary({
      projectId: seed.project.id,
      activeTableId: table.id,
      groupBy: 'nonsense',
      aggregates: [{ op: 'count' }],
    }),
  ).rejects.toThrow(/INVALID_GROUP_BY/);
});

test('rejects an aggregate field that is not registered (422 INVALID_GROUP_BY)', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  await expect(
    groupSummary({
      projectId: seed.project.id,
      activeTableId: table.id,
      groupBy: 'status',
      aggregates: [{ op: 'avg', field: 'unregistered_field' }],
    }),
  ).rejects.toMatchObject({ code: 'INVALID_GROUP_BY' });
});

test('accepts built-in columns (status/title/type) as the groupBy without a fields row', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  await seedWorkItems(db, seed.project.id, seed.workspace.id, table.id, 3, () => ({
    status: 'open',
    fm: {},
  }));
  const { groups } = await groupSummary({
    projectId: seed.project.id,
    activeTableId: table.id,
    groupBy: 'status',
    aggregates: [{ op: 'count' }],
  });
  expect(groups.find((g) => g.value === 'open')!.count).toBe(3);
});

// ---------- filter reuse (mitigation 5) ----------

test('a filter narrows the aggregated set', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  await registerField(db, seed.project.id, table.id, 'team', 'string');
  await seedWorkItems(db, seed.project.id, seed.workspace.id, table.id, 30, (i) => ({
    status: 'open',
    fm: { team: i < 10 ? 'a' : 'b' },
  }));
  const { groups } = await groupSummary({
    projectId: seed.project.id,
    activeTableId: table.id,
    groupBy: 'status',
    aggregates: [{ op: 'count' }],
    filter: { team: 'a' },
  });
  // Only the 10 team:'a' docs are aggregated.
  expect(groups.find((g) => g.value === 'open')!.count).toBe(10);
});

// ---------- project scope (mitigation 6) ----------

test('does NOT aggregate rows from another project', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  // A SECOND project in the same workspace with its own docs.
  const otherProjectId = nanoid();
  await db.insert(projects).values({
    id: otherProjectId,
    workspaceId: seed.workspace.id,
    slug: 'other',
    name: 'Other',
  });
  await seedWorkItems(db, seed.project.id, seed.workspace.id, table.id, 5, () => ({
    status: 'open',
    fm: {},
  }));
  // Other-project docs (no tableId — they are not in `table`).
  await db.insert(documents).values(
    Array.from({ length: 7 }, (_, i) => ({
      id: nanoid(),
      projectId: otherProjectId,
      workspaceId: seed.workspace.id,
      tableId: null,
      type: 'work_item' as const,
      slug: `other-${i}`,
      title: `Other ${i}`,
      status: 'open',
      body: '',
      frontmatter: {},
    })),
  );
  const { groups } = await groupSummary({
    projectId: seed.project.id,
    activeTableId: table.id,
    groupBy: 'status',
    aggregates: [{ op: 'count' }],
  });
  // Only the 5 docs in the resolved project — NOT 12.
  expect(groups.find((g) => g.value === 'open')!.count).toBe(5);
});

// ---------- ungrouped bucket ----------

test('documents missing the groupBy field land in the ungrouped bucket', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  await registerField(db, seed.project.id, table.id, 'phase', 'string');
  // 4 with a phase, 6 without.
  await seedWorkItems(db, seed.project.id, seed.workspace.id, table.id, 10, (i) => ({
    status: 'open',
    fm: i < 4 ? { phase: 'design' } : {},
  }));
  const { groups, ungrouped } = await groupSummary({
    projectId: seed.project.id,
    activeTableId: table.id,
    groupBy: 'phase',
    aggregates: [{ op: 'count' }],
  });
  expect(groups.find((g) => g.value === 'design')!.count).toBe(4);
  expect(ungrouped).not.toBeNull();
  expect(ungrouped!.count).toBe(6);
  expect(ungrouped!.value).toBeNull();
});

// ---------- group cap / truncation (mitigation 4) ----------

test('caps the returned groups at MAX_GROUPS and flags truncated', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  await registerField(db, seed.project.id, table.id, 'bucket', 'string');
  // 250 distinct groups (> MAX_GROUPS of 200).
  await seedWorkItems(db, seed.project.id, seed.workspace.id, table.id, 250, (i) => ({
    status: 'open',
    fm: { bucket: `g${i}` },
  }));
  const { groups, truncated } = await groupSummary({
    projectId: seed.project.id,
    activeTableId: table.id,
    groupBy: 'bucket',
    aggregates: [{ op: 'count' }],
  });
  expect(truncated).toBe(true);
  expect(groups.length).toBeLessThanOrEqual(200);
});

test('does NOT flag truncated when group count is within MAX_GROUPS', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  await registerField(db, seed.project.id, table.id, 'bucket', 'string');
  await seedWorkItems(db, seed.project.id, seed.workspace.id, table.id, 10, (i) => ({
    status: 'open',
    fm: { bucket: `g${i % 5}` },
  }));
  const { groups, truncated } = await groupSummary({
    projectId: seed.project.id,
    activeTableId: table.id,
    groupBy: 'bucket',
    aggregates: [{ op: 'count' }],
  });
  expect(truncated).toBe(false);
  expect(groups).toHaveLength(5);
});

// ---------- distribution cap (mitigation 8) ----------

test('distribution caps to MAX_DISTRIBUTION_BUCKETS with an "other" fold', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  await registerField(db, seed.project.id, table.id, 'tag', 'string');
  // One group ('open') with 60 distinct tag values (> MAX_DISTRIBUTION_BUCKETS of 50).
  await seedWorkItems(db, seed.project.id, seed.workspace.id, table.id, 60, (i) => ({
    status: 'open',
    fm: { tag: `t${i}` },
  }));
  const { groups } = await groupSummary({
    projectId: seed.project.id,
    activeTableId: table.id,
    groupBy: 'status',
    aggregates: [{ op: 'distribution', field: 'tag' }],
  });
  const open = groups.find((g) => g.value === 'open')!;
  const dist = open.aggregates['distribution:tag'] as DistributionBucket[];
  expect(Array.isArray(dist)).toBe(true);
  // At most 50 named buckets + one "other".
  expect(dist.length).toBeLessThanOrEqual(51);
  const other = dist.find((b) => b.value === 'other');
  expect(other).toBeDefined();
  // The folded "other" carries the remaining 10 distinct-value docs.
  expect(other!.count).toBe(10);
  // Total across all buckets equals the group size.
  expect(dist.reduce((s, b) => s + b.count, 0)).toBe(60);
});

test('distribution under the cap returns one bucket per distinct value, no "other"', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  await registerField(db, seed.project.id, table.id, 'tag', 'string');
  await seedWorkItems(db, seed.project.id, seed.workspace.id, table.id, 9, (i) => ({
    status: 'open',
    fm: { tag: `t${i % 3}` },
  }));
  const { groups } = await groupSummary({
    projectId: seed.project.id,
    activeTableId: table.id,
    groupBy: 'status',
    aggregates: [{ op: 'distribution', field: 'tag' }],
  });
  const dist = groups.find((g) => g.value === 'open')!.aggregates[
    'distribution:tag'
  ] as DistributionBucket[];
  expect(dist).toHaveLength(3);
  expect(dist.find((b) => b.value === 'other')).toBeUndefined();
  expect(dist.reduce((s, b) => s + b.count, 0)).toBe(9);
});

// ---------- empty/zero state ----------

test('returns an empty result for a project with no documents (200-shaped, not a throw)', async () => {
  const { seed } = await makeTestApp();
  const result = await groupSummary({
    projectId: seed.project.id,
    activeTableId: undefined,
    groupBy: 'status',
    aggregates: [{ op: 'count' }],
  });
  expect(result.groups).toEqual([]);
  expect(result.ungrouped).toBeNull();
  expect(result.truncated).toBe(false);
});

// ---------- HTTPError shape ----------

test('a denial throws an HTTPError (so the route serializer maps it to a 422)', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  try {
    await groupSummary({
      projectId: seed.project.id,
      activeTableId: table.id,
      groupBy: 'status',
      aggregates: [{ op: 'evil' as never }],
    });
    throw new Error('should have thrown');
  } catch (e) {
    expect(e).toBeInstanceOf(HTTPError);
    expect((e as HTTPError).status).toBe(422);
  }
});
