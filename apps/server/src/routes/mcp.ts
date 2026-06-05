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
import { type AuthContext, getUser } from '../middleware/auth.ts';
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

  // Everything else (service-layer HTTPError, plain handler errors) → internal
  // error carrying the human-readable message (legacy behavior).
  return { jsonrpc: '2.0', id, error: { code: -32603, message: msg } };
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
  const actor = getUser(c);

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
    const params = (body.params ?? {}) as {
      name?: string;
      arguments?: Record<string, unknown>;
    };
    try {
      const result = await executeTool(
        token,
        actor.id,
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
      return c.json<JsonRpcResponse>({ jsonrpc: '2.0', id, result });
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
