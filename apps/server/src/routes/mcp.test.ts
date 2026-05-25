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
