import { test, expect } from 'bun:test';
import { nanoid } from 'nanoid';
import { makeTestApp } from '../test/harness.ts';
import { db } from '../db/client.ts';
import { apiTokens } from '../db/schema.ts';
import { newApiToken } from '../lib/auth.ts';

async function setupToken(
  workspaceId: string,
  userId: string,
  scopes: string[],
): Promise<string> {
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId,
    name: 'mcp-test',
    tokenHash: hash,
    scopes,
    createdBy: userId,
  });
  return token;
}

test('MCP rejects requests without a Bearer token', async () => {
  const { app } = await makeTestApp();
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  expect(res.status).toBe(401);
});

test('MCP initialize returns serverInfo + protocolVersion', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: { serverInfo: { name: string }; protocolVersion: string } };
  expect(body.result.serverInfo.name).toBe('folio');
  expect(body.result.protocolVersion).toBeTruthy();
});

test('MCP tools/list returns the 12 v1 tools', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const body = (await res.json()) as { result: { tools: { name: string }[] } };
  expect(body.result.tools.length).toBe(12);
});

test('MCP tools/call list_workspaces returns the workspaces visible to the token', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_workspaces', arguments: {} },
    }),
  });
  const body = (await res.json()) as { result: { content: { type: string; text: string }[] } };
  expect(body.result.content[0]!.type).toBe('text');
  const parsed = JSON.parse(body.result.content[0]!.text) as { workspaces: unknown[] };
  expect(parsed.workspaces.length).toBeGreaterThan(0);
});

test('MCP tools/call create_document requires documents:write', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'create_document',
        arguments: {
          workspace_slug: 'acme',
          project_slug: 'web',
          type: 'work_item',
          title: 'from mcp',
        },
      },
    }),
  });
  const body = (await res.json()) as { error?: { code: number; message: string } };
  expect(body.error).toBeDefined();
  expect(body.error!.code).toBe(-32603);
  expect(body.error!.message).toMatch(/documents:write/);
});

test('MCP tools/call create_document works with documents:write', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, [
    'documents:write',
    'documents:read',
  ]);
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'create_document',
        arguments: {
          workspace_slug: 'acme',
          project_slug: 'web',
          type: 'work_item',
          title: 'from mcp',
        },
      },
    }),
  });
  const body = (await res.json()) as { result?: { content: { type: string; text: string }[] } };
  expect(body.result).toBeDefined();
  const parsed = JSON.parse(body.result!.content[0]!.text) as { title: string };
  expect(parsed.title).toBe('from mcp');
});

async function callTool(
  app: Awaited<ReturnType<typeof makeTestApp>>['app'],
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Response> {
  return app.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
}

test('MCP tools/call update_document patches title + frontmatter', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, [
    'documents:write',
    'documents:read',
  ]);
  const created = await callTool(app, token, 'create_document', {
    workspace_slug: 'acme',
    project_slug: 'web',
    type: 'work_item',
    title: 'original',
    frontmatter: { priority: 'low' },
  });
  const createdBody = (await created.json()) as { result: { content: { text: string }[] } };
  const createdDoc = JSON.parse(createdBody.result.content[0]!.text) as { slug: string };

  const res = await callTool(app, token, 'update_document', {
    workspace_slug: 'acme',
    project_slug: 'web',
    slug: createdDoc.slug,
    title: 'patched',
    frontmatter: { priority: 'high' },
  });
  const body = (await res.json()) as { result?: { content: { text: string }[] }; error?: unknown };
  expect(body.error).toBeUndefined();
  const parsed = JSON.parse(body.result!.content[0]!.text) as {
    title: string;
    frontmatter: Record<string, unknown>;
  };
  expect(parsed.title).toBe('patched');
  expect(parsed.frontmatter['priority']).toBe('high');
});

test('MCP tools/call delete_document requires documents:delete and removes the doc', async () => {
  const { app, seed } = await makeTestApp();
  const writeOnly = await setupToken(seed.workspace.id, seed.user.id, [
    'documents:write',
    'documents:read',
  ]);
  const created = await callTool(app, writeOnly, 'create_document', {
    workspace_slug: 'acme',
    project_slug: 'web',
    type: 'work_item',
    title: 'to delete',
  });
  const createdBody = (await created.json()) as { result: { content: { text: string }[] } };
  const createdDoc = JSON.parse(createdBody.result.content[0]!.text) as { slug: string };

  // Write+read scopes are insufficient — delete needs documents:delete.
  const blocked = await callTool(app, writeOnly, 'delete_document', {
    workspace_slug: 'acme',
    project_slug: 'web',
    slug: createdDoc.slug,
  });
  const blockedBody = (await blocked.json()) as { error?: { message: string } };
  expect(blockedBody.error).toBeDefined();
  expect(blockedBody.error!.message).toMatch(/documents:delete/);

  // With the right scope the delete goes through and the doc disappears.
  const deleter = await setupToken(seed.workspace.id, seed.user.id, [
    'documents:delete',
    'documents:read',
  ]);
  const ok = await callTool(app, deleter, 'delete_document', {
    workspace_slug: 'acme',
    project_slug: 'web',
    slug: createdDoc.slug,
  });
  const okBody = (await ok.json()) as { result?: { content: { text: string }[] }; error?: unknown };
  expect(okBody.error).toBeUndefined();
  const parsed = JSON.parse(okBody.result!.content[0]!.text) as { ok: boolean; slug: string };
  expect(parsed.ok).toBe(true);
  expect(parsed.slug).toBe(createdDoc.slug);

  const reader = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const lookup = await callTool(app, reader, 'get_document', {
    workspace_slug: 'acme',
    project_slug: 'web',
    slug: createdDoc.slug,
  });
  const lookupBody = (await lookup.json()) as { error?: { message: string } };
  expect(lookupBody.error).toBeDefined();
  expect(lookupBody.error!.message).toMatch(/document not found/);
});

test('MCP tools/call list_statuses returns the seeded default statuses', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const res = await callTool(app, token, 'list_statuses', {
    workspace_slug: 'acme',
    project_slug: 'web',
  });
  const body = (await res.json()) as { result: { content: { text: string }[] }; error?: unknown };
  expect(body.error).toBeUndefined();
  const parsed = JSON.parse(body.result.content[0]!.text) as {
    table: { slug: string };
    statuses: { key: string }[];
  };
  expect(parsed.statuses.length).toBeGreaterThan(0);
  expect(parsed.table.slug).toBeTruthy();
});

test('MCP tools/call run_view returns documents for the default view', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, [
    'documents:write',
    'documents:read',
  ]);
  await callTool(app, token, 'create_document', {
    workspace_slug: 'acme',
    project_slug: 'web',
    type: 'work_item',
    title: 'view target',
  });

  const res = await callTool(app, token, 'run_view', {
    workspace_slug: 'acme',
    project_slug: 'web',
  });
  const body = (await res.json()) as { result?: { content: { text: string }[] }; error?: unknown };
  expect(body.error).toBeUndefined();
  const parsed = JSON.parse(body.result!.content[0]!.text) as {
    view: { id: string };
    documents: { title: string }[];
  };
  expect(parsed.view.id).toBeTruthy();
  expect(parsed.documents.some((d) => d.title === 'view target')).toBe(true);
});

// --- Phase 2.5: agent allow-list enforcement ---

import { documents, projects as projectsTbl } from '../db/schema.ts';

/** Mint an agent doc + an agent-bound token for tests. */
async function setupAgentBoundToken(
  workspaceId: string,
  userId: string,
  opts: { projects: string[]; scopes?: string[]; agentSlug?: string },
): Promise<{ agentToken: string; agentId: string; agentSlug: string }> {
  const agentId = nanoid();
  const agentSlug = opts.agentSlug ?? `agent-${nanoid(6)}`;
  await db.insert(documents).values({
    id: agentId,
    projectId: null,
    workspaceId,
    tableId: null,
    type: 'agent',
    slug: agentSlug,
    title: 'Test Agent',
    status: null,
    body: '',
    frontmatter: {
      system_prompt: 'help',
      model: 'm',
      provider: 'anthropic',
      tools: ['list_documents', 'create_document'],
      projects: opts.projects,
    },
    createdBy: userId,
    updatedBy: userId,
  });
  const { token: plaintext, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId,
    name: `agent:${agentSlug}`,
    tokenHash: hash,
    scopes: opts.scopes ?? ['documents:read', 'documents:write', 'documents:delete'],
    agentId,
    createdBy: userId,
  });
  return { agentToken: plaintext, agentId, agentSlug };
}

test('list_projects filters by agent allow-list (explicit ids)', async () => {
  const { app, db: testDb, seed } = await makeTestApp();
  // Add a second project.
  const projectBId = nanoid();
  await testDb.insert(projectsTbl).values({
    id: projectBId,
    workspaceId: seed.workspace.id,
    slug: 'inbox',
    name: 'Inbox',
  });
  const { agentToken } = await setupAgentBoundToken(seed.workspace.id, seed.user.id, {
    projects: [seed.project.id], // only project A
  });
  const res = await callTool(app, agentToken, 'list_projects', { workspace_slug: 'acme' });
  const body = (await res.json()) as { result: { content: { text: string }[] } };
  const parsed = JSON.parse(body.result.content[0]!.text) as {
    projects: { slug: string }[];
  };
  const slugs = parsed.projects.map((p) => p.slug);
  expect(slugs).toContain('web');     // project A
  expect(slugs).not.toContain('inbox'); // project B not in allow-list
});

test('list_projects returns all when agent.projects = ["*"]', async () => {
  const { app, db: testDb, seed } = await makeTestApp();
  const projectBId = nanoid();
  await testDb.insert(projectsTbl).values({
    id: projectBId,
    workspaceId: seed.workspace.id,
    slug: 'inbox',
    name: 'Inbox',
  });
  const { agentToken } = await setupAgentBoundToken(seed.workspace.id, seed.user.id, {
    projects: ['*'],
  });
  const res = await callTool(app, agentToken, 'list_projects', { workspace_slug: 'acme' });
  const body = (await res.json()) as { result: { content: { text: string }[] } };
  const parsed = JSON.parse(body.result.content[0]!.text) as {
    projects: { slug: string }[];
  };
  const slugs = parsed.projects.map((p) => p.slug);
  expect(slugs).toContain('web');
  expect(slugs).toContain('inbox');
});

test('list_documents on a disallowed project returns -32602 with reason agent_not_in_allow_list', async () => {
  const { app, db: testDb, seed } = await makeTestApp();
  const projectBId = nanoid();
  await testDb.insert(projectsTbl).values({
    id: projectBId,
    workspaceId: seed.workspace.id,
    slug: 'inbox',
    name: 'Inbox',
  });
  const { agentToken } = await setupAgentBoundToken(seed.workspace.id, seed.user.id, {
    projects: [seed.project.id], // project A only
  });
  const res = await callTool(app, agentToken, 'list_documents', {
    workspace_slug: 'acme',
    project_slug: 'inbox',
  });
  const body = (await res.json()) as {
    error: { code: number; data?: { reason: string } };
  };
  expect(body.error.code).toBe(-32602);
  expect(body.error.data?.reason).toBe('agent_not_in_allow_list');
});

test('create_document with type=agent is rejected via MCP in Phase 2.5', async () => {
  const { app, seed } = await makeTestApp();
  const { agentToken } = await setupAgentBoundToken(seed.workspace.id, seed.user.id, {
    projects: ['*'],
  });
  const res = await callTool(app, agentToken, 'create_document', {
    workspace_slug: 'acme',
    project_slug: 'web',
    type: 'agent',
    title: 'No can do',
    frontmatter: { system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [] },
  });
  const body = (await res.json()) as { error: { code: number; message: string } };
  expect(body.error.code).toBe(-32602);
  expect(body.error.message).toMatch(/workspace-scoped HTTP endpoint/);
});

test('create_document with type=trigger is rejected via MCP in Phase 2.5', async () => {
  const { app, seed } = await makeTestApp();
  const { agentToken } = await setupAgentBoundToken(seed.workspace.id, seed.user.id, {
    projects: ['*'],
  });
  const res = await callTool(app, agentToken, 'create_document', {
    workspace_slug: 'acme',
    project_slug: 'web',
    type: 'trigger',
    title: 'Nope',
    frontmatter: { agent: 'x', schedule: '0 9 * * 1', on_event: null },
  });
  const body = (await res.json()) as { error: { code: number } };
  expect(body.error.code).toBe(-32602);
});

test('human PAT (no agent_id) is not subject to allow-list checks', async () => {
  const { app, db: testDb, seed } = await makeTestApp();
  const projectBId = nanoid();
  await testDb.insert(projectsTbl).values({
    id: projectBId,
    workspaceId: seed.workspace.id,
    slug: 'inbox',
    name: 'Inbox',
  });
  const humanToken = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const res = await callTool(app, humanToken, 'list_projects', { workspace_slug: 'acme' });
  const body = (await res.json()) as { result: { content: { text: string }[] } };
  const parsed = JSON.parse(body.result.content[0]!.text) as {
    projects: { slug: string }[];
  };
  expect(parsed.projects.map((p) => p.slug)).toEqual(['inbox', 'web'].sort());
});
