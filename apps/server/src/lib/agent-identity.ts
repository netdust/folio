/**
 * Agent-identity resolution — the ONE place a bearer token is resolved to its
 * agent `Document` (invariant 13). Two call-shapes over one core:
 *
 *   - resolveAgentDocForToken  — THROW variant (the registry's contract): a
 *     missing/not-bound token raises an MCP `-32602` invalid-params error with a
 *     `reason` of `agent_missing` / `not_agent_bound`. Returns `Document`.
 *   - resolveCallingAgentDoc   — SOFT variant (the widening-guards' contract):
 *     a missing/not-bound token returns `undefined` so the guards apply their
 *     fail-closed ([] allow-list / [] tools) fallback. Returns `Document |
 *     undefined`.
 *
 * Both check the un-forgeable `isOperator` marker FIRST, before the `agentId`
 * branch. The operator is a code singleton (invariant 13): its ephemeral token
 * carries `isOperator: true` + `agentId = null` (Shape B′ — no FK sentinel). If
 * the agentId branch ran first it would hit `agent_missing` and break the
 * operator entirely — the exact bug invariant 13 was named to fix. The marker is
 * the discriminant: it is set only server-side at mint, never read from a
 * persisted `documents`/`api_tokens` column, so it cannot be forged by a caller.
 *
 * This module is the CONVERGENCE LEAF: it imports only its data dependencies
 * (`db`, schema) and two leaf helpers (`getOperatorDocument`, `mcpInvalidParams`)
 * — never `agent-guards.ts` nor `agent-tools-registry.ts`. That breaks the cycle
 * that previously forced the registry and the guards to each fork their own copy
 * of this resolution (the registry imports the guards' widening asserts, so the
 * guards could not import the resolver back from the registry). Both call-sites
 * now import from HERE.
 */

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { type Document, type EphemeralToken, documents } from '../db/schema.ts';
import { mcpInvalidParams } from './mcp-errors.ts';
import { getOperatorDocument } from './operator.ts';

/**
 * Shared core: marker-FIRST, then the agentId DB lookup. Returns the operator
 * code-singleton doc for an operator-marked token, the agent row for a real
 * agent-bound token, or `null` for both "not agent-bound" (agentId null, no
 * marker) and "agent-bound but the row is gone" (non-null agentId, no row). The
 * two public wrappers turn `null` into either a throw or `undefined` — they
 * differ ONLY in that response, so the resolution itself can never drift.
 *
 * The discriminant between the two null cases (so the throw-variant can emit the
 * right `reason`) is `token.agentId`: null → `not_agent_bound`, non-null →
 * `agent_missing`.
 */
async function resolveCore(token: EphemeralToken): Promise<Document | null> {
  // M1: operator marker is checked BEFORE any agentId branch.
  if (token.isOperator) return getOperatorDocument();
  if (!token.agentId) return null; // not agent-bound (a human PAT / session)
  const agent = await db.query.documents.findFirst({
    where: and(eq(documents.id, token.agentId), eq(documents.type, 'agent')),
  });
  return agent ?? null; // agent-bound but the row is gone
}

/**
 * THROW variant (the registry / MCP-tool contract). Resolves the operator via
 * its marker; throws `mcpInvalidParams` with `reason: 'not_agent_bound'` for a
 * token with no agentId, or `reason: 'agent_missing'` for an agent-bound token
 * whose row no longer exists.
 */
export async function resolveAgentDocForToken(token: EphemeralToken): Promise<Document> {
  const doc = await resolveCore(token);
  if (doc) return doc;
  if (!token.agentId) {
    throw mcpInvalidParams('token is not agent-bound', { reason: 'not_agent_bound' });
  }
  throw mcpInvalidParams('agent for this token no longer exists', { reason: 'agent_missing' });
}

/**
 * SOFT variant (the widening-guards' contract). Resolves the operator via its
 * marker; returns `undefined` (NOT a throw) for a not-bound token or an
 * agent-bound token whose row is gone, so the guards keep their fail-closed
 * fallback for those cases.
 */
export async function resolveCallingAgentDoc(token: EphemeralToken): Promise<Document | undefined> {
  return (await resolveCore(token)) ?? undefined;
}
