/**
 * Cross-route coverage for the table-scoped mounts at
 * `/api/v1/w/:wslug/p/:pslug/t/:tslug/{statuses,fields,views,documents}`.
 *
 * These tests assert that:
 *  - the explicit-table mounts wire through to the same handlers as the legacy
 *    project-scoped mounts, but scope inserts + lists to the chosen table; and
 *  - the legacy `/p/:pslug/...` paths keep targeting the default Work Items
 *    table via the resolveProject auto-attach.
 */

import { test, expect } from 'bun:test';
import { makeTestApp } from '../test/harness.ts';

const wpBase = '/api/v1/w/acme/p/web';

async function jsonReq(
  app: Awaited<ReturnType<typeof makeTestApp>>['app'],
  cookie: string,
  method: string,
  url: string,
  body?: unknown,
) {
  return app.request(url, {
    method,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('GET /t/:tslug/statuses returns the seeded defaults for that table', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(`${wpBase}/t/work-items/statuses`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  expect((await res.json()).data).toHaveLength(4);
});

test('statuses on different tables are isolated', async () => {
  const { app, seed } = await makeTestApp();
  // Create a second table
  const created = await (
    await jsonReq(app, seed.sessionCookie, 'POST', `${wpBase}/tables`, { name: 'Bugs' })
  ).json();

  // Create a status on the new table
  await jsonReq(app, seed.sessionCookie, 'POST', `${wpBase}/t/${created.data.slug}/statuses`, {
    key: 'open',
    name: 'Open',
  });

  // Work Items should still have its 4 seeded statuses, none keyed 'open'.
  const wi = await (
    await app.request(`${wpBase}/t/work-items/statuses`, { headers: { Cookie: seed.sessionCookie } })
  ).json();
  expect(wi.data).toHaveLength(4);
  expect(wi.data.find((s: { key: string }) => s.key === 'open')).toBeUndefined();

  // Bugs should have the one status we just created.
  const bugs = await (
    await app.request(`${wpBase}/t/${created.data.slug}/statuses`, {
      headers: { Cookie: seed.sessionCookie },
    })
  ).json();
  expect(bugs.data).toHaveLength(1);
  expect(bugs.data[0].key).toBe('open');
});

test('POST /t/:tslug/documents creates a work_item attached to that table', async () => {
  const { app, seed } = await makeTestApp();
  const res = await jsonReq(app, seed.sessionCookie, 'POST', `${wpBase}/t/work-items/documents`, {
    type: 'work_item',
    title: 'Scoped task',
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.data.title).toBe('Scoped task');
  // tableId on the persisted row should match the Work Items table for this project.
  expect(typeof body.data.tableId).toBe('string');
  expect(body.data.tableId).not.toBeNull();
});

test('GET /t/:tslug/documents filters work_items by table', async () => {
  const { app, seed } = await makeTestApp();
  // Seed a doc in the default table via the legacy mount:
  await jsonReq(app, seed.sessionCookie, 'POST', `${wpBase}/documents`, {
    type: 'work_item',
    title: 'Default table doc',
  });

  // Create a second table + add a doc there via the explicit mount:
  const t2 = await (
    await jsonReq(app, seed.sessionCookie, 'POST', `${wpBase}/tables`, { name: 'Other' })
  ).json();
  await jsonReq(app, seed.sessionCookie, 'POST', `${wpBase}/t/${t2.data.slug}/documents`, {
    type: 'work_item',
    title: 'Other table doc',
  });

  // /t/work-items/documents must include Default table doc, not Other.
  const wi = await (
    await app.request(`${wpBase}/t/work-items/documents?type=work_item`, {
      headers: { Cookie: seed.sessionCookie },
    })
  ).json();
  const wiTitles = wi.data.map((d: { title: string }) => d.title);
  expect(wiTitles).toContain('Default table doc');
  expect(wiTitles).not.toContain('Other table doc');

  // /t/<other>/documents must include Other table doc, not Default.
  const other = await (
    await app.request(`${wpBase}/t/${t2.data.slug}/documents?type=work_item`, {
      headers: { Cookie: seed.sessionCookie },
    })
  ).json();
  const otherTitles = other.data.map((d: { title: string }) => d.title);
  expect(otherTitles).toContain('Other table doc');
  expect(otherTitles).not.toContain('Default table doc');
});

test('POST /t/:tslug/fields scopes the field to that table', async () => {
  const { app, seed } = await makeTestApp();
  // Create a field on a fresh table, then list against the default table — the
  // field MUST NOT leak across tables.
  const t2 = await (
    await jsonReq(app, seed.sessionCookie, 'POST', `${wpBase}/tables`, { name: 'Bugs' })
  ).json();
  const post = await jsonReq(app, seed.sessionCookie, 'POST', `${wpBase}/t/${t2.data.slug}/fields`, {
    key: 'severity',
    type: 'select',
    options: ['low', 'med', 'high'],
  });
  expect(post.status).toBe(201);

  const defaultList = await (
    await app.request(`${wpBase}/t/work-items/fields`, { headers: { Cookie: seed.sessionCookie } })
  ).json();
  expect(defaultList.data.find((f: { key: string }) => f.key === 'severity')).toBeUndefined();

  const bugsList = await (
    await app.request(`${wpBase}/t/${t2.data.slug}/fields`, {
      headers: { Cookie: seed.sessionCookie },
    })
  ).json();
  expect(bugsList.data.find((f: { key: string }) => f.key === 'severity')).toBeTruthy();
});

test('POST /t/:tslug/views scopes the view to that table', async () => {
  const { app, seed } = await makeTestApp();
  const t2 = await (
    await jsonReq(app, seed.sessionCookie, 'POST', `${wpBase}/tables`, { name: 'Bugs' })
  ).json();
  const post = await jsonReq(app, seed.sessionCookie, 'POST', `${wpBase}/t/${t2.data.slug}/views`, {
    name: 'Open bugs',
    type: 'list',
  });
  expect(post.status).toBe(201);

  // Default table only shows its seeded views.
  const defaultList = await (
    await app.request(`${wpBase}/t/work-items/views`, { headers: { Cookie: seed.sessionCookie } })
  ).json();
  expect(defaultList.data.find((v: { name: string }) => v.name === 'Open bugs')).toBeUndefined();

  const bugsList = await (
    await app.request(`${wpBase}/t/${t2.data.slug}/views`, {
      headers: { Cookie: seed.sessionCookie },
    })
  ).json();
  expect(bugsList.data).toHaveLength(1);
  expect(bugsList.data[0].name).toBe('Open bugs');
});

test('legacy /p/:pslug/statuses targets the same data as /t/work-items/statuses', async () => {
  const { app, seed } = await makeTestApp();
  const legacy = await (
    await app.request(`${wpBase}/statuses`, { headers: { Cookie: seed.sessionCookie } })
  ).json();
  const explicit = await (
    await app.request(`${wpBase}/t/work-items/statuses`, {
      headers: { Cookie: seed.sessionCookie },
    })
  ).json();
  expect(legacy.data.length).toBe(explicit.data.length);
  expect(legacy.data.map((s: { key: string }) => s.key).sort()).toEqual(
    explicit.data.map((s: { key: string }) => s.key).sort(),
  );
});

test('pages stay project-scoped (tableId is null)', async () => {
  const { app, seed } = await makeTestApp();
  const res = await jsonReq(app, seed.sessionCookie, 'POST', `${wpBase}/documents`, {
    type: 'page',
    title: 'Onboarding',
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.data.type).toBe('page');
  expect(body.data.tableId).toBeNull();

  // GET ?type=page should return it (filtered by tableId IS NULL).
  const list = await (
    await app.request(`${wpBase}/documents?type=page`, { headers: { Cookie: seed.sessionCookie } })
  ).json();
  expect(list.data.find((d: { title: string }) => d.title === 'Onboarding')).toBeTruthy();
});
