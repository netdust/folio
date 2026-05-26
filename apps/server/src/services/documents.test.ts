/**
 * Service-level tests for the documents service.
 *
 * These don't go through HTTP — they call the service functions directly.
 * The route tests in routes/documents.test.ts cover the HTTP layer; these
 * cover the service contract that Task 12b's MCP server will rely on.
 */

import { test, expect } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { makeTestApp } from '../test/harness.ts';
import { apiTokens, tables } from '../db/schema.ts';
import {
  createDocument,
  deleteDocument,
  getDocument,
  listDocuments,
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
