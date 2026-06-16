/**
 * ROUTE-LEVEL (un-mocked HTTP wire) acceptance tests for the group-summary
 * endpoint — the Cluster 2a integration gate. The service tests (services/
 * group-summary.test.ts) call `groupSummary()` directly; THIS file drives the
 * real Hono route through `app.request` so the WIRE is exercised: route-ordering
 * (`/group-summary` wins over `/:slug`), query-param parsing (JSON.parse of
 * `aggregates`/`filter`, the 8192-byte cap), the pScope auth (denied actor), and
 * the 422 error mapping through the real `registerErrorHandler` serializer.
 *
 * Tier A — this is the un-mocked-seam the service tests deferred (FULL-tier
 * parsing→SQL surface). Mirrors the `app.request` + `seed.sessionCookie` style of
 * views.test.ts / documents.test.ts.
 */

import { expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { documents, tables } from '../db/schema.ts';
import { makeTestApp } from '../test/harness.ts';

const base = '/api/v1/w/acme/p/web/t/work-items/documents/group-summary';

async function workItemsTableId(
  db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  projectId: string,
): Promise<string> {
  const t = await db.query.tables.findFirst({
    where: and(eq(tables.projectId, projectId), eq(tables.slug, 'work-items')),
  });
  if (!t) throw new Error('test setup: work-items table missing');
  return t.id;
}

async function seed(
  db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  projectId: string,
  workspaceId: string,
  tableId: string,
  rows: Array<{ status: string }>,
): Promise<void> {
  await db.insert(documents).values(
    rows.map((r, i) => ({
      id: nanoid(),
      projectId,
      workspaceId,
      tableId,
      type: 'work_item' as const,
      slug: `wi-${i}-${nanoid(6)}`,
      title: `WI ${i}`,
      status: r.status,
      body: '',
      frontmatter: {},
    })),
  );
}

function url(params: Record<string, string>): string {
  const sp = new URLSearchParams(params);
  return `${base}?${sp.toString()}`;
}

test('WIRE: valid spec aggregates over the FULL set, grouped by status (200)', async () => {
  const { app, db, seed: s } = await makeTestApp();
  const tableId = await workItemsTableId(db, s.project.id);
  // 90 done, 60 open — deliberately > one page (50) so a page-scoped bug would show.
  await seed(db, s.project.id, s.workspace.id, tableId, [
    ...Array.from({ length: 90 }, () => ({ status: 'done' })),
    ...Array.from({ length: 60 }, () => ({ status: 'open' })),
  ]);

  const res = await app.request(
    url({ groupBy: 'status', aggregates: JSON.stringify([{ op: 'count' }]) }),
    { headers: { Cookie: s.sessionCookie } },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()).data as {
    groups: { value: string | null; count: number }[];
    truncated: boolean;
  };
  const done = body.groups.find((g) => g.value === 'done');
  const open = body.groups.find((g) => g.value === 'open');
  expect(done?.count).toBe(90); // FULL set, not a 50-row page
  expect(open?.count).toBe(60);
  expect(body.truncated).toBe(false);
});

test('WIRE: denied actor — no session cookie → 401/403, never 200', async () => {
  const { app } = await makeTestApp();
  const res = await app.request(
    url({ groupBy: 'status', aggregates: JSON.stringify([{ op: 'count' }]) }),
    // no Cookie header
  );
  expect([401, 403]).toContain(res.status);
});

test('WIRE: unknown aggregation op → 422 INVALID_AGGREGATE (not 500)', async () => {
  const { app, seed: s } = await makeTestApp();
  const res = await app.request(
    url({ groupBy: 'status', aggregates: JSON.stringify([{ op: 'evil' }]) }),
    { headers: { Cookie: s.sessionCookie } },
  );
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('INVALID_AGGREGATE');
});

test('WIRE: bad groupBy key → 422 INVALID_GROUP_BY', async () => {
  const { app, seed: s } = await makeTestApp();
  const res = await app.request(
    url({ groupBy: "x'); DROP", aggregates: JSON.stringify([{ op: 'count' }]) }),
    { headers: { Cookie: s.sessionCookie } },
  );
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('INVALID_GROUP_BY');
});

test('WIRE: malformed aggregates JSON → 422, never a 500', async () => {
  const { app, seed: s } = await makeTestApp();
  const res = await app.request(url({ groupBy: 'status', aggregates: '{not json' }), {
    headers: { Cookie: s.sessionCookie },
  });
  expect(res.status).toBe(422);
});

test('WIRE: an oversized filter (>8192 bytes) → 422 INVALID_FILTER before parse', async () => {
  const { app, seed: s } = await makeTestApp();
  const huge = JSON.stringify({ status: { $in: Array.from({ length: 2000 }, (_, i) => `v${i}`) } });
  const res = await app.request(
    url({ groupBy: 'status', aggregates: JSON.stringify([{ op: 'count' }]), filter: huge }),
    { headers: { Cookie: s.sessionCookie } },
  );
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('INVALID_FILTER');
});

test('WIRE: route-ordering — /group-summary is NOT swallowed by /:slug', async () => {
  // A document literally slugged "group-summary" must NOT shadow the endpoint.
  // The aggregate route is registered before /:slug, so this hits the aggregate
  // handler (200 with groups), not the document-detail handler.
  const { app, seed: s } = await makeTestApp();
  const res = await app.request(
    url({ groupBy: 'status', aggregates: JSON.stringify([{ op: 'count' }]) }),
    { headers: { Cookie: s.sessionCookie } },
  );
  expect(res.status).toBe(200);
  expect((await res.json()).data).toHaveProperty('groups');
});

test('WIRE: pct_matching value is a bound param — injection string counts as a literal', async () => {
  const { app, db, seed: s } = await makeTestApp();
  const tableId = await workItemsTableId(db, s.project.id);
  await seed(db, s.project.id, s.workspace.id, tableId, [
    ...Array.from({ length: 10 }, () => ({ status: 'done' })),
    ...Array.from({ length: 10 }, () => ({ status: 'open' })),
  ]);
  const res = await app.request(
    url({
      groupBy: 'status',
      aggregates: JSON.stringify([{ op: 'pct_matching', field: 'status', value: "x' OR '1'='1" }]),
    }),
    { headers: { Cookie: s.sessionCookie } },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()).data as {
    groups: { value: string | null; aggregates: Record<string, number> }[];
  };
  // The injection string matches NO status → 0% in every group (NOT 100%/all rows).
  for (const g of body.groups) {
    const pct = g.aggregates["pct_matching:status:x' OR '1'='1"];
    expect(pct).toBe(0);
  }
});
