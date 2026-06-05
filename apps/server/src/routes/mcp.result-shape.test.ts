/**
 * MCP `tools/call` result-shape contract — `toMcpToolResult`.
 *
 * MCP requires every `tools/call` result to carry a `content` array. The general
 * bridge tools `folio_api`/`folio_api_get` return a bare `{ status, body }`
 * (correct for the in-process runner, which JSON.stringifies any tool return),
 * which the MCP route must wrap here at the single transport convergence point.
 * Before this normalizer, that bare object reached the MCP client as EMPTY
 * output — the HTTP call succeeded but its body never rendered.
 *
 * These assert the normalizer directly (unit) and through the live JSON-RPC
 * route (seam), including the negative pass-through case so a `textResult`
 * handler is never double-wrapped.
 */

import { expect, test } from 'bun:test';
import { nanoid } from 'nanoid';
import { db } from '../db/client.ts';
import { apiTokens } from '../db/schema.ts';
import { newApiToken } from '../lib/auth.ts';
import { makeTestApp } from '../test/harness.ts';
import { toMcpToolResult } from './mcp.ts';

test('toMcpToolResult wraps a bare {status,body} into the MCP content shape', () => {
  const out = toMcpToolResult({ status: 200, body: { data: [{ slug: 'x' }] } });
  expect(Array.isArray(out.content)).toBe(true);
  const block = out.content[0]!;
  expect(block.type).toBe('text');
  // The full bare object is serialized into the text payload — status + body.
  expect(JSON.parse(block.text)).toEqual({ status: 200, body: { data: [{ slug: 'x' }] } });
});

test('toMcpToolResult passes an already-shaped {content:[...]} result through verbatim (no double-wrap)', () => {
  const shaped = { content: [{ type: 'text' as const, text: '{"projects":[]}' }] };
  const out = toMcpToolResult(shaped);
  expect(out).toBe(shaped); // same reference — not re-wrapped
  // A double-wrap would produce content[0].text === JSON.stringify(shaped); guard against it.
  expect(out.content[0]!.text).toBe('{"projects":[]}');
});

test('toMcpToolResult serializes a refuse-with-plan envelope as text (not a protocol error)', () => {
  const refusal = { refused: true, reason: 'secret-class write', plan: { method: 'POST', path: '/x' } };
  const out = toMcpToolResult(refusal);
  expect(JSON.parse(out.content[0]!.text)).toEqual(refusal);
});

test('toMcpToolResult passes a plain string through as text', () => {
  const out = toMcpToolResult('hello');
  expect(out.content[0]!.text).toBe('hello');
});

test('folio_api_get over the live MCP route returns a non-empty content array (regression: empty output)', async () => {
  const { app, seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    name: 'shape-test',
    tokenHash: hash,
    scopes: ['documents:read'],
    createdBy: seed.user.id,
  });

  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'folio_api_get', arguments: { path: `/api/v1/w/${seed.workspace.slug}/projects` } },
    }),
  });

  const json = (await res.json()) as {
    result?: { content?: { type: string; text: string }[] };
  };
  // The bug: result was `{status,body}` with NO content array → empty render.
  expect(json.result?.content).toBeDefined();
  expect(Array.isArray(json.result?.content)).toBe(true);
  const block = json.result?.content?.[0];
  expect(block?.type).toBe('text');
  // And the wrapped text carries the real HTTP body (status + projects payload).
  const inner = JSON.parse(block?.text ?? '{}') as { status: number; body: unknown };
  expect(inner.status).toBe(200);
  expect(inner.body).toBeDefined();
});
