/**
 * D-3 — error-mapping contract for the thin MCP transport.
 *
 * After D-3, `routes/mcp.ts` delegates `tools/call` to `executeTool` and maps
 * the thrown error into a JSON-RPC envelope via `mapToolErrorToJsonRpc`. These
 * tests exercise that mapping THROUGH the live JSON-RPC route:
 *
 *   - unknown tool            → -32601
 *   - missing scope           → -32603 with data.required_scope
 *   - Zod-rejected argument   → -32602 with data.issues carrying PATHS only,
 *                               NEVER the rejected value (mitigation 61).
 */

import { expect, test } from 'bun:test';
import { nanoid } from 'nanoid';
import { db } from '../db/client.ts';
import { apiTokens } from '../db/schema.ts';
import { newApiToken } from '../lib/auth.ts';
import { makeTestApp } from '../test/harness.ts';

async function setupToken(workspaceId: string, userId: string, scopes: string[]): Promise<string> {
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId,
    name: 'mcp-errmap-test',
    tokenHash: hash,
    scopes,
    createdBy: userId,
  });
  return token;
}

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
      id: 7,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
}

test('unknown tool maps to -32601', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const res = await callTool(app, token, 'no_such_tool', {});
  const body = (await res.json()) as { error?: { code: number; message: string } };
  expect(body.error).toBeDefined();
  expect(body.error!.code).toBe(-32601);
  expect(body.error!.message).toMatch(/method not found/);
});

test('missing scope maps to -32603 with data.required_scope', async () => {
  const { app, seed } = await makeTestApp();
  // create_document needs documents:write; give the token only documents:read.
  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const res = await callTool(app, token, 'create_document', {
    workspace_slug: 'acme',
    project_slug: 'web',
    type: 'work_item',
    title: 'blocked by scope',
  });
  const body = (await res.json()) as {
    error?: { code: number; message: string; data?: { required_scope?: string } };
  };
  expect(body.error).toBeDefined();
  expect(body.error!.code).toBe(-32603);
  expect(body.error!.data?.required_scope).toBe('documents:write');
  expect(body.error!.message).toMatch(/documents:write/);
});

test('Zod-rejected argument maps to -32602 with issue PATHS only, never the value (mitigation 61)', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  // list_documents.limit is z.number().optional(); pass a string that ALSO
  // contains a recognizable sentinel. The sentinel must NOT leak into the
  // error response — only the path ("limit") may appear.
  const sentinel = 'SENTINEL_BAD_VALUE_d0n0tl3ak';
  const res = await callTool(app, token, 'list_documents', {
    workspace_slug: 'acme',
    project_slug: 'web',
    limit: sentinel,
  });
  const body = (await res.json()) as {
    error?: { code: number; message: string; data?: { issues?: { path: unknown }[] } };
  };
  expect(body.error).toBeDefined();
  expect(body.error!.code).toBe(-32602);
  // The path is carried; assert it points at `limit`.
  const issues = body.error!.data?.issues ?? [];
  expect(issues.length).toBeGreaterThan(0);
  const paths = issues.flatMap((i) => i.path as unknown[]);
  expect(paths).toContain('limit');
  // Mitigation 61: the rejected value must not appear anywhere in the response.
  const raw = JSON.stringify(body);
  expect(raw).not.toContain(sentinel);
});
