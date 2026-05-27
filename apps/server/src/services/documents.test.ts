/**
 * Service-level tests for the documents service.
 *
 * These don't go through HTTP — they call the service functions directly.
 * The route tests in routes/documents.test.ts cover the HTTP layer; these
 * cover the service contract that Task 12b's MCP server will rely on.
 */

import { test, expect } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { makeTestApp } from '../test/harness.ts';
import { apiTokens, documents, tables } from '../db/schema.ts';
import type { Document } from '../db/schema.ts';
import { HTTPError } from '../lib/http.ts';
import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  updateDocument,
} from './documents.ts';

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

test('listDocuments returns docs for the given project', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  await createDocument({
    workspace: seed.workspace,
    project: seed.project,
    table,
    actor: seed.user,
    token: null,
    input: {
      type: 'work_item',
      title: 'Hello',
      body: '',
      frontmatter: {},
      status: null,
    },
  });
  const { data } = await listDocuments({
    projectId: seed.project.id,
    activeTableId: table.id,
    type: 'work_item',
  });
  expect(data).toHaveLength(1);
  expect(data[0]!.slug).toBe('hello');
});

test('getDocument returns null for unknown slug', async () => {
  const { seed } = await makeTestApp();
  const row = await getDocument(seed.project.id, 'nope');
  expect(row).toBeNull();
});

test('createDocument (workspace-scoped) mints + persists an agent token bound to the agent', async () => {
  const { db, seed } = await makeTestApp();
  const { document, agentTokenPlaintext } = await createDocument({
    workspace: seed.workspace,
    project: null,
    table: null,
    actor: seed.user,
    token: null,
    input: {
      type: 'agent',
      title: 'Bot',
      body: '',
      frontmatter: {
        system_prompt: 'help',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        tools: ['list_documents', 'get_document'],
      },
      status: null,
    },
  });
  expect(agentTokenPlaintext).toBeString();
  expect(agentTokenPlaintext!.length).toBeGreaterThan(20);
  const apiTokenId = (document.frontmatter as Record<string, unknown>)['api_token_id'];
  expect(typeof apiTokenId).toBe('string');
  const row = await db.query.apiTokens.findFirst({
    where: eq(apiTokens.id, apiTokenId as string),
  });
  expect(row).toBeTruthy();
  expect(row!.workspaceId).toBe(seed.workspace.id);
  // Phase 2.5: agent_id is set so the cascade FK can revoke on delete.
  expect(row!.agentId).toBe(document.id);
});

test('deleteDocument (workspace-scoped) on agent revokes its api token via cascade', async () => {
  const { db, seed } = await makeTestApp();
  const { document } = await createDocument({
    workspace: seed.workspace,
    project: null,
    table: null,
    actor: seed.user,
    token: null,
    input: {
      type: 'agent',
      title: 'Goner',
      body: '',
      frontmatter: {
        system_prompt: 'go',
        model: 'gpt-4o',
        provider: 'openai',
        tools: ['list_documents'],
      },
      status: null,
    },
  });
  const apiTokenId = (document.frontmatter as Record<string, unknown>)[
    'api_token_id'
  ] as string;
  const before = await db.query.apiTokens.findFirst({
    where: eq(apiTokens.id, apiTokenId),
  });
  expect(before).toBeTruthy();

  await deleteDocument({
    workspace: seed.workspace,
    project: null,
    actor: seed.user,
    existing: document,
  });

  const after = await db.query.apiTokens.findFirst({
    where: eq(apiTokens.id, apiTokenId),
  });
  expect(after).toBeUndefined();
});

// ----- Phase 2.6 sub-phase D: builtin trigger lock -----

async function seedTrigger(
  db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  workspaceId: string,
  opts: { builtin: boolean; slug?: string },
): Promise<Document> {
  const id = nanoid();
  const slug = opts.slug ?? (opts.builtin ? 'builtin-on-foo' : 'custom-on-foo');
  await db.insert(documents).values({
    id,
    workspaceId,
    projectId: null,
    type: 'trigger',
    slug,
    title: 'Test trigger',
    body: '',
    frontmatter: {
      on_event: 'comment.created',
      schedule: null,
      agent: null,
      enabled: true,
      builtin: opts.builtin,
    },
  });
  const row = await db.query.documents.findFirst({
    where: eq(documents.id, id),
  });
  if (!row) throw new Error('seedTrigger: insert failed');
  return row;
}

test('updateDocument blocks PATCH on builtin trigger fields other than enabled', async () => {
  const { db, seed } = await makeTestApp();
  const trig = await seedTrigger(db, seed.workspace.id, { builtin: true });
  await expect(
    updateDocument({
      workspace: seed.workspace,
      project: null,
      fallbackTable: null,
      actor: seed.user,
      existing: trig,
      patch: { frontmatter: { event_filter: { kind: 'foo' } } },
    }),
  ).rejects.toMatchObject({ code: 'BUILTIN_TRIGGER_LOCKED', status: 422 });
});

test('updateDocument allows PATCH on enabled for builtin trigger', async () => {
  const { db, seed } = await makeTestApp();
  const trig = await seedTrigger(db, seed.workspace.id, { builtin: true });
  const updated = await updateDocument({
    workspace: seed.workspace,
    project: null,
    fallbackTable: null,
    actor: seed.user,
    existing: trig,
    patch: { frontmatter: { enabled: false } },
  });
  expect((updated.frontmatter as Record<string, unknown>).enabled).toBe(false);
  // Builtin flag is preserved.
  expect((updated.frontmatter as Record<string, unknown>).builtin).toBe(true);
});

test('updateDocument blocks PATCH on builtin trigger title change', async () => {
  const { db, seed } = await makeTestApp();
  const trig = await seedTrigger(db, seed.workspace.id, { builtin: true });
  await expect(
    updateDocument({
      workspace: seed.workspace,
      project: null,
      fallbackTable: null,
      actor: seed.user,
      existing: trig,
      patch: { title: 'Renamed' },
    }),
  ).rejects.toMatchObject({ code: 'BUILTIN_TRIGGER_LOCKED', status: 422 });
});

test('updateDocument blocks PATCH on builtin trigger body change', async () => {
  const { db, seed } = await makeTestApp();
  const trig = await seedTrigger(db, seed.workspace.id, { builtin: true });
  await expect(
    updateDocument({
      workspace: seed.workspace,
      project: null,
      fallbackTable: null,
      actor: seed.user,
      existing: trig,
      patch: { body: 'New body' },
    }),
  ).rejects.toMatchObject({ code: 'BUILTIN_TRIGGER_LOCKED', status: 422 });
});

test('updateDocument allows full patch on non-builtin trigger', async () => {
  const { db, seed } = await makeTestApp();
  const trig = await seedTrigger(db, seed.workspace.id, { builtin: false });
  const updated = await updateDocument({
    workspace: seed.workspace,
    project: null,
    fallbackTable: null,
    actor: seed.user,
    existing: trig,
    patch: { frontmatter: { event_filter: { kind: 'foo' } } },
  });
  expect(
    (updated.frontmatter as Record<string, unknown>).event_filter,
  ).toMatchObject({ kind: 'foo' });
});

test('deleteDocument blocks delete on builtin trigger', async () => {
  const { db, seed } = await makeTestApp();
  const trig = await seedTrigger(db, seed.workspace.id, { builtin: true });
  let caught: unknown;
  try {
    await deleteDocument({
      workspace: seed.workspace,
      project: null,
      actor: seed.user,
      existing: trig,
    });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(HTTPError);
  expect((caught as HTTPError).code).toBe('BUILTIN_TRIGGER_LOCKED');
  expect((caught as HTTPError).status).toBe(422);
  // Row still exists.
  const still = await db.query.documents.findFirst({
    where: eq(documents.id, trig.id),
  });
  expect(still).toBeTruthy();
});

test('deleteDocument allows delete on non-builtin trigger', async () => {
  const { db, seed } = await makeTestApp();
  const trig = await seedTrigger(db, seed.workspace.id, { builtin: false });
  await deleteDocument({
    workspace: seed.workspace,
    project: null,
    actor: seed.user,
    existing: trig,
  });
  const gone = await db.query.documents.findFirst({
    where: eq(documents.id, trig.id),
  });
  expect(gone).toBeUndefined();
});
