/**
 * Hand-rolled JSON-RPC 2.0 MCP endpoint at POST /mcp.
 *
 * Speaks `initialize`, `tools/list`, `tools/call`, and `ping`. This route is a
 * THIN TRANSPORT: it parses the JSON-RPC envelope, resolves the bearer token +
 * actor, and delegates `tools/call` to `executeTool` — the ONE dispatch+auth
 * point shared with the in-process agent runner (lib/agent-tools.ts). The 20
 * production tools live in the shared registry (lib/agent-tools-registry.ts);
 * `executeTool` does lookup + scope-check + Zod-validation + dispatch. This
 * route does NOT re-implement any of that.
 *
 * Error mapping (`mapToolErrorToJsonRpc`) translates thrown errors into JSON-RPC
 * error envelopes:
 *   - Errors already carrying a numeric `.code` (mcpInvalidParams, lifted agent
 *     guards, human-PAT rejection) pass through verbatim (code + message + data).
 *   - `executeTool`'s plain `Error('method not found: …')` → -32601.
 *   - `executeTool`'s `Error('forbidden: scope <s> missing')` → -32603 with
 *     `data.required_scope` (preserving the legacy MCP scope-rejection shape).
 *   - `executeTool`'s `Error('MCP_INVALID_ARGS')` (Zod reject) → -32602 with
 *     `data.issues` carrying PATHS only — never the rejected arg value
 *     (mitigation 61).
 *   - Anything else → -32603 with the message.
 *
 * Mitigation 62: `tools/list` is NOT filtered by the caller's scopes — it
 * advertises the full registry. Scope is enforced at call time by `executeTool`.
 */

import { Hono } from 'hono';
import { executeTool, listToolDefs } from '../lib/agent-tools.ts';
import { HTTPError } from '../lib/http.ts';
import type { AuthContext } from '../middleware/auth.ts';
import { attachToken, getToken, requireToken } from '../middleware/bearer.ts';

// --- JSON-RPC types ---

type JsonRpcId = number | string;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Normalize a tool handler's return value into the MCP `tools/call` result
 * shape `{ content: [{ type: 'text', text }] }`.
 *
 * MCP requires every `tools/call` result to carry a `content` array; a bare
 * object in the JSON-RPC `result` field is rendered as NOTHING by the client.
 * Most registry handlers already return the shaped form (via `textResult`), but
 * the general bridge tools `folio_api`/`folio_api_get` deliberately return a
 * bare `{ status, body }` — that envelope is correct for the IN-PROCESS agent
 * runner (which JSON.stringifies any non-string tool return), but over the MCP
 * wire it must be wrapped here, at the single transport convergence point,
 * rather than re-shaped in each handler. (A bare `{status, body}` from
 * `folio_api_get` previously reached the MCP client as empty output — the HTTP
 * call succeeded but its body never rendered.)
 *
 * Already-shaped results (any object with a `content` array) pass through
 * verbatim so the `textResult` handlers are never double-wrapped.
 */
export function toMcpToolResult(result: unknown): { content: { type: 'text'; text: string }[] } {
  if (
    result !== null &&
    typeof result === 'object' &&
    Array.isArray((result as { content?: unknown }).content)
  ) {
    return result as { content: { type: 'text'; text: string }[] };
  }
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return { content: [{ type: 'text', text }] };
}

/**
 * Translate an error thrown by `executeTool` (or a handler it called) into a
 * JSON-RPC error response. Mitigation 61: only PATHS are serialized for invalid
 * args — the rejected arg VALUE is never placed in the response.
 */
function mapToolErrorToJsonRpc(err: unknown, id: JsonRpcId): JsonRpcResponse {
  const e = err as {
    message?: string;
    code?: number;
    data?: unknown;
    issues?: unknown;
  };

  // Errors already carrying a JSON-RPC code/data (mcpInvalidParams, lifted agent
  // guards, mcpRejectHumanPat) pass through verbatim — D-2 made the handlers
  // emit the exact shape the MCP route promised, so this is a pure copy.
  if (typeof e.code === 'number') {
    return {
      jsonrpc: '2.0',
      id,
      error:
        e.data !== undefined
          ? { code: e.code, message: e.message ?? 'error', data: e.data }
          : { code: e.code, message: e.message ?? 'error' },
    };
  }

  const msg = e.message ?? String(err);

  // executeTool: `method not found: <name>` → legacy MCP "unknown tool" shape.
  if (msg.startsWith('method not found')) {
    return { jsonrpc: '2.0', id, error: { code: -32601, message: msg } };
  }

  // executeTool: `forbidden: scope <s> missing` → legacy MCP scope-rejection
  // shape: -32603, message mentioning the scope, and data.required_scope so
  // callers can branch programmatically.
  if (msg.startsWith('forbidden: scope ')) {
    const scope = msg.replace('forbidden: scope ', '').replace(' missing', '');
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: `tool requires scope: ${scope}`,
        data: { required_scope: scope },
      },
    };
  }

  // executeTool: Zod rejection. `issues` is [{ path }] — PATHS only, never the
  // rejected value (mitigation 61).
  if (msg === 'MCP_INVALID_ARGS') {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32602, message: 'invalid arguments', data: { issues: e.issues } },
    };
  }

  // M-MCP-1 — a service-layer HTTPError carries a DELIBERATE, author-controlled,
  // agent-facing message (e.g. 'comment documents must be created via the comment
  // tool'). Keep it, and surface its string `code` in `data.code` for programmatic
  // branching. (The two INVALID_FILTER sites that wrapped a RAW inner e.message were
  // fixed at the source — services no longer leak raw detail into an HTTPError.)
  if (err instanceof HTTPError) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: err.message, data: { code: err.code } },
    };
  }

  // Everything else — an UNEXPECTED raw Error / DB / crypto error — is sanitized.
  // Returning its raw `.message` would leak SQL fragments, table/column names, file
  // paths, or stack text. The HTTP transport collapses these to 'internal error'
  // via registerErrorHandler.onError; the MCP transport had NO equivalent backstop.
  // Fixed string out, real detail logged server-side only (mirrors
  // sanitizeProviderError's never-echo-e.message contract).
  console.error('[mcp] tool error (sanitized to internal error):', err);
  return { jsonrpc: '2.0', id, error: { code: -32603, message: 'internal error' } };
}

// --- Route ---

const mcpRoute = new Hono<AuthContext>();
mcpRoute.use('*', attachToken, requireToken);

mcpRoute.post('/', async (c) => {
  let body: JsonRpcRequest;
  try {
    body = (await c.req.json()) as JsonRpcRequest;
  } catch {
    return c.json<JsonRpcResponse>(
      {
        jsonrpc: '2.0',
        id: 0,
        error: { code: -32700, message: 'parse error' },
      },
      200,
    );
  }

  const id = body.id;
  const token = getToken(c);
  // M-MCP-2 — do NOT resolve the user up-front. getUser(c) THROWS when no user is
  // hydrated (a valid token with a null/dangling createdBy), and calling it before
  // method routing crashed EVERY method (incl. ping/initialize/tools/list, which
  // need no user) with a raw Hono 500. The actor is resolved fail-closed inside
  // tools/call (the only method that needs it).

  if (body.method === 'initialize') {
    return c.json<JsonRpcResponse>({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'folio', version: '0.1.0' },
        capabilities: { tools: {} },
        // Discovery pointer for the outside agent (Claude Code over MCP): Folio
        // is markdown-native + agent-first, with an instance skill library.
        // get_skill(slug) pulls a skill body before shaping a workspace.
        instructions:
          'Folio is markdown-native and agent-first. Instance skills are available via get_skill. ' +
          'Call get_skill(slug) to load a skill body (e.g. get_skill("folio") for the API manual) ' +
          'before shaping projects, tables, views, or adding a provider. Reads via folio_api_get; writes via folio_api.',
      },
    });
  }

  if (body.method === 'ping') {
    return c.json<JsonRpcResponse>({ jsonrpc: '2.0', id, result: {} });
  }

  if (body.method === 'tools/list') {
    // Mitigation 62: unfiltered by scope — the full registry is advertised.
    // Scope is enforced at call time by executeTool, not at discovery time.
    return c.json<JsonRpcResponse>({
      jsonrpc: '2.0',
      id,
      result: { tools: listToolDefs() },
    });
  }

  if (body.method === 'tools/call') {
    // M-MCP-2 — resolve the actor fail-closed (getUser throws if unhydrated). A
    // valid token whose creator can't be resolved gets a clean sanitized JSON-RPC
    // error, NOT a raw 500.
    const actorUser = c.get('user');
    if (!actorUser) {
      console.error(`[mcp] tools/call with a token that has no resolvable user (token ${token.id})`);
      return c.json<JsonRpcResponse>({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: 'internal error' },
      });
    }
    const params = (body.params ?? {}) as {
      name?: string;
      arguments?: Record<string, unknown>;
    };
    try {
      const result = await executeTool(
        token,
        actorUser.id,
        params.name ?? '',
        params.arguments ?? {},
        undefined,
        {
          // MCP delegation (D2/D3): the bearer TOKEN-HOLDER is the caller, so
          // the caller authority IS the token's own scopes/projects. The
          // agent∩caller intersect is a no-op here (token ∩ itself), which
          // correctly preserves MCP's always-token-scoped authority while
          // satisfying the executeTool caller contract. Authority is taken from
          // the authenticated token, NEVER from the request body (D2).
          callerScopes: token.scopes,
        },
      );
      // Normalize to the MCP `content` shape at this single transport point —
      // bare `{status,body}` returns (folio_api/_get) would otherwise render as
      // empty output in the client; `textResult` handlers pass through verbatim.
      return c.json<JsonRpcResponse>({ jsonrpc: '2.0', id, result: toMcpToolResult(result) });
    } catch (err) {
      return c.json<JsonRpcResponse>(mapToolErrorToJsonRpc(err, id));
    }
  }

  return c.json<JsonRpcResponse>({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `method not supported: ${body.method}` },
  });
});

export { mcpRoute };
