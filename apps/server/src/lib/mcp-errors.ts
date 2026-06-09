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

import type { EphemeralToken } from '../db/schema.ts';
import { mayManageAgentLifecycle } from './agent-guards.ts';
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
 * MCP face of the agent-lifecycle gate. Agent CRUD via MCP (`create_agent` /
 * `update_agent` / `delete_agent`) is an auth-grant mutation: it mints,
 * modifies, or revokes an `agent_token` bearer credential.
 *
 * Delegates the allow/deny decision to `mayManageAgentLifecycle`
 * (`agent-guards.ts`) — the single convergence point that BOTH this MCP face
 * and the HTTP face (`assertNotHumanPatForAgentLifecycle`) route through, so
 * the two transports can never drift apart.
 *
 * As of 2026-06-09 (headless-Folio Phase 1, D1) the gate ADMITS admin
 * (`agents:write`) human PATs alongside session callers and agent-bound bearers
 * (incl. the operator via its isOperator marker). The HTTP face is NOW gated
 * too — the prior "HTTP-side agent CRUD is intentionally NOT gated" carve-out
 * is gone; both faces share this one predicate. A member / stolen lower-scope
 * PAT (no `agents:write`) is still rejected — the stolen-credential escalation
 * shape this gate was built to close.
 *
 * Uses code -32000 (JSON-RPC "server-defined error"). The round-6 code -32601
 * was overloaded: SDK clients (including the Cursor MCP client) branch on
 * -32601 → 'capability missing' handler and lose `data.reason` in the process.
 * -32000 is the protocol's catch-all for server-defined errors; SDKs preserve
 * `data` on this code, so the downstream
 * `data.reason: 'human_pat_rejected_on_agent_lifecycle'` stays addressable.
 *
 * NAME NOTE (2026-06-09, D1): renamed from `mcpRejectHumanPat` — it no longer
 * rejects human PATs as a CLASS; it admits admin (`agents:write`) PATs and
 * rejects only insufficiently-scoped bearers. The wire-level `data.reason`
 * string is kept byte-for-byte (`human_pat_rejected_on_agent_lifecycle`) for
 * MCP-client compatibility — clients branch on it, so it is a frozen contract
 * even though the literal phrase now over-describes the rejected set.
 */
export function assertMcpAgentLifecycle(token: EphemeralToken): void {
  if (mayManageAgentLifecycle(token)) return;
  const err = new Error(
    'agent-lifecycle tools require session auth, an agent-bound bearer, or an admin (agents:write) token',
  ) as Error & { code: number; data: Record<string, unknown> };
  err.code = -32000;
  err.data = { reason: 'human_pat_rejected_on_agent_lifecycle' };
  throw err;
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
