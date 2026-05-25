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
