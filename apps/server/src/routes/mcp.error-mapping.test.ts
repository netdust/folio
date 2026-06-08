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

// M-MCP-1 policy — an UNEXPECTED raw Error (not an explicitly-shaped JSON-RPC
// error and not an HTTPError) must NOT reflect its raw message to the client. The
// HTTP transport collapses unknowns to 'internal error' via onError; the MCP
// transport must do the same, or it leaks SQL/paths/stack text (sibling of the
// provider sanitizeProviderError leak). HTTPError messages are KEPT — they are
// deliberate, author-controlled, agent-facing validation text.
test('M-MCP-1 — an UNEXPECTED raw Error returns the SANITIZED internal error, not the raw message', async () => {
  const { app, seed } = await makeTestApp();
  const { registerTool } = await import('../lib/agent-tools.ts');
  const { z } = await import('zod');
  const leakName = `__test_rawerror_leak_${nanoid(6)}`;
  // Mimics an unexpected DB/crypto/runtime error whose .message embeds internal detail.
  const SECRET = 'LEAK_internal_table_users_ssn_d0n0tl3ak';
  registerTool({
    name: leakName,
    requiredScope: 'documents:read',
    schema: z.object({}).strict(),
    handler: async () => {
      throw new Error(`SQLITE_ERROR: no such column: ${SECRET}`);
    },
  });

  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const res = await callTool(app, token, leakName, {});
  const body = (await res.json()) as { error?: { code: number; message: string } };

  expect(body.error).toBeDefined();
  expect(body.error!.code).toBe(-32603);
  // Sanitized: a fixed internal-error string, NOT the raw handler message.
  expect(body.error!.message).toBe('internal error');
  // The secret must not appear ANYWHERE in the response.
  expect(JSON.stringify(body)).not.toContain(SECRET);
});

// M-MCP-1 policy — an HTTPError's message IS kept (deliberate, agent-facing), with
// its string code surfaced in data.code for programmatic branching. This is what
// lets useful validation feedback ('comment documents must be created via …')
// survive while UNEXPECTED errors (the test above) are sanitized.
test('M-MCP-1 — an HTTPError keeps its deliberate message + surfaces its code in data', async () => {
  const { app, seed } = await makeTestApp();
  const { registerTool } = await import('../lib/agent-tools.ts');
  const { HTTPError } = await import('../lib/http.ts');
  const { z } = await import('zod');
  const name = `__test_httperror_keep_${nanoid(6)}`;
  registerTool({
    name,
    requiredScope: 'documents:read',
    schema: z.object({}).strict(),
    handler: async () => {
      throw new HTTPError('SOME_VALIDATION', 'this input is not allowed here', 422);
    },
  });

  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const res = await callTool(app, token, name, {});
  const body = (await res.json()) as {
    error?: { code: number; message: string; data?: { code?: string } };
  };
  expect(body.error!.code).toBe(-32603);
  expect(body.error!.message).toBe('this input is not allowed here');
  expect(body.error!.data?.code).toBe('SOME_VALIDATION');
});

test('M-MCP-1 — a plain Error-throwing tool also returns the sanitized internal error', async () => {
  const { app, seed } = await makeTestApp();
  const { registerTool } = await import('../lib/agent-tools.ts');
  const { z } = await import('zod');
  const leakName = `__test_rawerror_leak_${nanoid(6)}`;
  const SECRET = 'LEAK_stack_frame_apps_server_src_secret_d0n0tl3ak';
  registerTool({
    name: leakName,
    requiredScope: 'documents:read',
    schema: z.object({}).strict(),
    handler: async () => {
      throw new Error(`unexpected: ${SECRET}`);
    },
  });

  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const res = await callTool(app, token, leakName, {});
  const body = (await res.json()) as { error?: { code: number; message: string } };

  expect(body.error!.code).toBe(-32603);
  expect(body.error!.message).toBe('internal error');
  expect(JSON.stringify(body)).not.toContain(SECRET);
});

// M-MCP-2 — a VALID token whose creator can't be hydrated (createdBy null/dangling)
// must NOT crash the endpoint with a raw 500. getUser(c) was called unconditionally
// at the top of the handler, before method routing and outside the try, so EVERY
// method (incl. ping/initialize/tools/list, which need no user) threw a raw Hono 500.
async function userlessToken(workspaceId: string): Promise<string> {
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId,
    name: 'mcp-userless',
    tokenHash: hash,
    scopes: ['documents:read'],
    createdBy: null, // no hydratable creator → no user attached
  });
  return token;
}

test('M-MCP-2 — a userless token does NOT 500 on ping (no user needed)', async () => {
  const { app, seed } = await makeTestApp();
  const token = await userlessToken(seed.workspace.id);
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  expect(body.result).toBeDefined();
  expect(body.error).toBeUndefined();
});

test('M-MCP-2 — a userless token gets a clean JSON-RPC error on tools/call, not a 500', async () => {
  const { app, seed } = await makeTestApp();
  const token = await userlessToken(seed.workspace.id);
  const res = await callTool(app, token, 'list_workspaces', {});
  // A clean JSON-RPC error envelope (sanitized), NOT a raw 500.
  expect(res.status).toBe(200);
  const body = (await res.json()) as { error?: { code: number; message: string } };
  expect(body.error).toBeDefined();
  expect(body.error!.code).toBe(-32603);
  expect(body.error!.message).toBe('internal error');
});

// M-MCP-3 — the JSON-RPC envelope is validated. body was cast `as JsonRpcRequest`
// with no schema, so a non-object body (a batch array, a bare string/number) or a
// wrong-typed id round-tripped into the response, breaking JSON-RPC 2.0 conformance.
async function postRaw(
  app: Awaited<ReturnType<typeof makeTestApp>>['app'],
  token: string,
  rawBody: string,
): Promise<Response> {
  return app.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: rawBody,
  });
}

test('M-MCP-3 — a non-object body (JSON array / batch) is rejected with -32600 invalid request', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const res = await postRaw(app, token, JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { error?: { code: number; message: string }; id?: unknown };
  expect(body.error?.code).toBe(-32600);
  expect(body.error?.message).toMatch(/invalid request/i);
  // id is null (a non-object body has no usable id).
  expect(body.id).toBeNull();
});

test('M-MCP-3 — a bare string body is rejected with -32600', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const res = await postRaw(app, token, JSON.stringify('not an object'));
  const body = (await res.json()) as { error?: { code: number } };
  expect(body.error?.code).toBe(-32600);
});

test('M-MCP-3 — a wrong-typed id (object) is coerced to null in the response', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  // id is an object — invalid per JSON-RPC 2.0 (must be string|number|null).
  const res = await postRaw(
    app,
    token,
    JSON.stringify({ jsonrpc: '2.0', id: { evil: 'nested' }, method: 'ping' }),
  );
  const body = (await res.json()) as { id?: unknown; result?: unknown };
  // ping still works; the bad id is coerced to null, NOT reflected verbatim.
  expect(body.id).toBeNull();
  expect(body.result).toBeDefined();
});

test('M-MCP-3 — a valid string id still round-trips unchanged', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const res = await postRaw(app, token, JSON.stringify({ jsonrpc: '2.0', id: 'req-42', method: 'ping' }));
  const body = (await res.json()) as { id?: unknown };
  expect(body.id).toBe('req-42');
});

// Coverage hardening (shakeout test-effectiveness) — the parse / dispatch guards
// the auditor flagged as blind.
test('malformed JSON body returns -32700 parse error', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const res = await postRaw(app, token, '{not valid json');
  expect(res.status).toBe(200);
  const body = (await res.json()) as { error?: { code: number; message: string } };
  expect(body.error?.code).toBe(-32700);
  expect(body.error?.message).toMatch(/parse error/i);
});

test('an unknown top-level method returns -32601 method not supported', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const res = await postRaw(app, token, JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'frobnicate' }));
  const body = (await res.json()) as { error?: { code: number; message: string } };
  expect(body.error?.code).toBe(-32601);
  expect(body.error?.message).toMatch(/method not supported/i);
});

test('tools/call with a missing tool name maps to -32601 (empty name → method not found)', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const res = await postRaw(
    app,
    token,
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { arguments: {} } }),
  );
  const body = (await res.json()) as { error?: { code: number } };
  expect(body.error?.code).toBe(-32601);
});
