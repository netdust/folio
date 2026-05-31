/**
 * Shared MCP JSON-RPC error helpers.
 *
 * These translate thrown errors into the JSON-RPC error shapes the MCP protocol
 * promises. They are consumed by BOTH transport faces:
 *
 *   - `routes/mcp.ts` — the JSON-RPC transport, which copies a thrown error's
 *     `.code`/`.data`/`.message` into the response envelope.
 *   - `lib/agent-tools-registry.ts` — the migrated production tools, whose
 *     handlers throw these so the MCP route's transport stays a pure pass-through.
 *
 * Keeping them in one module avoids the drift risk of byte-identical copies in
 * both files.
 */

import type { ApiToken } from '../db/schema.ts';
import { HTTPError } from './http.ts';

/**
 * MCP JSON-RPC "invalid params" error (-32602). Carries structured `data` so the
 * agent can branch on `reason` programmatically; the human-readable `message`
 * stays brief.
 */
export function mcpInvalidParams(message: string, data: Record<string, unknown>): Error {
  const err = new Error(message) as Error & { code: number; data: Record<string, unknown> };
  err.code = -32602;
  err.data = data;
  return err;
}

/**
 * Auth-grant mutations on the agent surface MUST reject human PATs.
 *
 * Agent CRUD via MCP (`create_agent` / `update_agent` / `delete_agent`) is an
 * auth-grant mutation: it mints, modifies, or revokes an `agent_token` bearer
 * credential. An agent-bound bearer (token.agentId set) calling these has a
 * legitimate use case — agent self-management / parent spawning a child. A
 * human PAT calling them has the SAME SHAPE as a stolen-credential escalation:
 * the attacker mints a new agent with arbitrary scopes and pivots through it.
 *
 * Symmetric carve-out: HTTP-side agent CRUD (`POST/PATCH/DELETE
 * /api/v1/w/:wslug/documents` with `type=agent`) is intentionally NOT gated
 * — that's the admin-facing surface where workspace admins manage agents.
 * MCP is the agent-facing surface; gating MCP closes the privilege-escalation
 * vector without breaking admin workflows.
 *
 * Uses code -32000 (JSON-RPC "server-defined error"). The round-6 code -32601
 * was overloaded: SDK clients (including the Cursor MCP client) branch on
 * -32601 → 'capability missing' handler and lose `data.reason` in the process.
 * -32000 is the protocol's catch-all for server-defined errors; SDKs preserve
 * `data` on this code, so the downstream
 * `data.reason: 'human_pat_rejected_on_agent_lifecycle'` stays addressable.
 */
export function mcpRejectHumanPat(token: ApiToken): void {
  if (!token.agentId) {
    const err = new Error(
      'agent-lifecycle tools require an agent-bound bearer; human PATs are rejected',
    ) as Error & { code: number; data: Record<string, unknown> };
    err.code = -32000;
    err.data = { reason: 'human_pat_rejected_on_agent_lifecycle' };
    throw err;
  }
}

/**
 * Translate an HTTPError thrown by `lib/agent-guards.ts` into the MCP-shaped
 * error so create_agent / update_agent / delete_agent all surface the same
 * `error.data.reason` strings the protocol promises.
 */
export function rethrowAgentGuardAsMcp(err: unknown): never {
  if (err instanceof HTTPError) {
    if (err.code === 'ALLOW_LIST_WIDENING_FORBIDDEN') {
      throw mcpInvalidParams(err.message, { reason: 'allow_list_widening_forbidden' });
    }
    if (err.code === 'TOOLS_WIDENING_FORBIDDEN') {
      throw mcpInvalidParams(err.message, { reason: 'tools_widening_forbidden' });
    }
    if (err.code === 'CANNOT_DELETE_SELF') {
      throw mcpInvalidParams(err.message, { reason: 'cannot_delete_self' });
    }
  }
  throw err as Error;
}
