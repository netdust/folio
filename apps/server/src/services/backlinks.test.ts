/**
 * Service-level tests for the query-time backlink resolver.
 *
 * Backlinks are computed at QUERY TIME from frontmatter wiki-links
 * (`[[slug]]`) — nothing is stored in reverse, so they can't drift. The
 * resolver must match the target slug whether it appears as a single
 * top-level relation string OR as an element of a multi-relation array.
 */

import { test, expect } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { makeTestApp } from '../test/harness.ts';
import { tables } from '../db/schema.ts';
import { createDocument } from './documents.ts';
import { findBacklinks } from './backlinks.ts';

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

test('findBacklinks matches single-string and array-element links, excludes non-matches and self', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);

  const make = (title: string, frontmatter: Record<string, unknown>) =>
    createDocument({
      workspace: seed.workspace,
      project: seed.project,
      table,
      actor: seed.user,
      token: null,
      input: { type: 'work_item', title, body: '', frontmatter, status: null },
    });

  // Target doc. "People: Ada" slugifies to people-ada — pin it.
  const { document: target } = await make('People: Ada', {});
  expect(target.slug).toBe('people-ada');

  // Single top-level relation link.
  await make('Bug A', { owner: '[[people-ada]]' });
  // Multi-relation array link (element match).
  await make('Bug B', { watchers: ['[[people-ada]]', '[[someone-else]]'] });
  // Non-matching link.
  await make('Bug C', { owner: '[[other-person]]' });

  const rows = await findBacklinks({
    workspaceId: seed.workspace.id,
    projectId: seed.project.id,
    slug: 'people-ada',
  });

  const titles = rows.map((r) => r.title).sort();
  expect(titles).toEqual(['Bug A', 'Bug B']);
});

const docsPath = '/api/v1/w/acme/p/web/documents';

test('GET /documents/:slug/backlinks returns linking docs', async () => {
  const { app, db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);

  const { document: target } = await createDocument({
    workspace: seed.workspace,
    project: seed.project,
    table,
    actor: seed.user,
    token: null,
    input: { type: 'work_item', title: 'People: Ada', body: '', frontmatter: {}, status: null },
  });
  expect(target.slug).toBe('people-ada');

  const { document: linker } = await createDocument({
    workspace: seed.workspace,
    project: seed.project,
    table,
    actor: seed.user,
    token: null,
    input: {
      type: 'work_item',
      title: 'Bug A',
      body: '',
      frontmatter: { owner: '[[people-ada]]' },
      status: null,
    },
  });

  const res = await app.request(`${docsPath}/people-ada/backlinks`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.data.map((r: { slug: string }) => r.slug)).toContain(linker.slug);
});

test('GET /documents/:slug/backlinks 404 for unknown slug', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(`${docsPath}/nope/backlinks`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(404);
  expect((await res.json()).error.code).toBe('DOCUMENT_NOT_FOUND');
});
