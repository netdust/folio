import { describe, expect, test } from 'bun:test';
import type { EphemeralToken } from '../db/schema.ts';
import { assertNotHumanPatForAgentLifecycle, mayManageAgentLifecycle } from './agent-guards.ts';
import { roleToScopes } from './agent-schema.ts';
import { assertMcpAgentLifecycle } from './mcp-errors.ts';

const tok = (over: Partial<EphemeralToken>): EphemeralToken =>
  ({ id: 't', workspaceId: 'w', createdBy: 'u', scopes: [], agentId: null, ...over }) as EphemeralToken;

describe('mayManageAgentLifecycle', () => {
  test('session (no token) → allowed', () => {
    expect(mayManageAgentLifecycle(null)).toBe(true);
  });
  test('agent-bound bearer → allowed', () => {
    expect(mayManageAgentLifecycle(tok({ agentId: 'agt_1' }))).toBe(true);
  });
  test('operator (isOperator marker, agentId null) → allowed', () => {
    expect(mayManageAgentLifecycle(tok({ agentId: null, isOperator: true }))).toBe(true);
  });
  test('human PAT WITH agents:write (owner/admin) → allowed', () => {
    expect(mayManageAgentLifecycle(tok({ scopes: ['documents:write', 'agents:write'] }))).toBe(true);
  });
  test('human PAT WITHOUT agents:write (member/stolen) → rejected', () => {
    expect(mayManageAgentLifecycle(tok({ scopes: ['documents:read', 'documents:write'] }))).toBe(false);
  });
});

// Mitigation 3 (spec threat model): the MCP gate (assertMcpAgentLifecycle) and the
// HTTP gate (assertNotHumanPatForAgentLifecycle) MUST make the SAME
// agent-lifecycle decision for every token shape — they delegate to the one
// shared predicate, so they agree BY CONSTRUCTION. This test goes RED if a
// future edit re-diverges them (the exact privilege-escalation hole the shared
// predicate exists to prevent).
describe('MCP and HTTP agent-lifecycle gates converge', () => {
  function mcpRejects(t: EphemeralToken): boolean {
    try {
      assertMcpAgentLifecycle(t);
      return false;
    } catch {
      return true;
    }
  }
  function httpRejects(t: EphemeralToken | null): boolean {
    try {
      assertNotHumanPatForAgentLifecycle('agent', t);
      return false;
    } catch {
      return true;
    }
  }

  // NB: assertMcpAgentLifecycle takes a non-null EphemeralToken (the MCP transport
  // only calls it for bearer-authed requests; a sessionless caller is rejected
  // upstream at 401). The HTTP gate additionally handles the session (null)
  // case. The shared shapes below are the ones BOTH faces actually evaluate.
  const sharedShapes: EphemeralToken[] = [
    tok({ agentId: 'a' }), // agent-bound bearer
    tok({ agentId: null, isOperator: true }), // operator marker
    tok({ scopes: ['agents:write'] }), // admin PAT
    tok({ scopes: ['documents:write'] }), // member PAT
    tok({ scopes: [] }), // scopeless PAT
  ];

  test('MCP and HTTP gates agree for every (bearer) token shape', () => {
    for (const s of sharedShapes) {
      expect(mcpRejects(s)).toBe(httpRejects(s));
    }
  });

  test('HTTP gate additionally allows the session (null) caller', () => {
    expect(httpRejects(null)).toBe(false);
  });
});

// Mitigation 4 (spec threat model) — STRUCTURAL half. The D1 loosening admits
// human PATs holding `agents:write`. The escalation worry is "a NON-admin mints
// an agent WIDER than itself." That is blocked at the ROLE level: `agents:write`
// is granted by roleToScopes ONLY to owner/admin (a `member` PAT can never hold
// it — mintToken's roleToScopes ceiling, locked by tokens.test.ts:195,213), and
// owner/admin ALSO always hold config:write + documents:delete. So the principal
// reaching agent creation is always an owner/admin who already holds the full
// document-scope set — a minted agent can never exceed that role's authority.
//
// NOTE (security-review 2026-06-09): this does NOT mean an `agents:write` PAT
// necessarily co-carries delete/config — an admin CAN deliberately mint a NARROW
// PAT (e.g. ['agents:write','documents:write']) and the widening guards skip
// human PATs (agent-guards.ts:93,177), so its minted agent's tools-derived token
// can hold delete/config the narrow PAT omitted. That is the spec's ACCEPTED,
// documented residual: the minting actor is a full owner/admin who gains nothing
// past their own role authority, and the minted token stays revocable
// (api_tokens.agent_id cascade — Task 1). Not a boundary crossing; bounded by
// role + revocability, not by "narrow PATs are un-mintable".
//
// This test pins the role-level co-occurrence the argument rests on; the
// agent-bound-caller widening path is locked separately by mcp.test.ts F2
// (allow_list_widening_forbidden / tools-widening).
describe('mitigation 4 — agents:write co-occurs with the full admin scope set', () => {
  test('roleToScopes(member) never grants agents:write (member cannot reach agent creation)', () => {
    expect(roleToScopes('member')).not.toContain('agents:write');
  });
  test('roleToScopes(owner/admin) granting agents:write ALSO grants config:write + documents:delete', () => {
    for (const role of ['owner', 'admin'] as const) {
      const scopes = roleToScopes(role);
      expect(scopes).toContain('agents:write');
      // The co-occurrence that makes "admin mints wider than self" impossible:
      expect(scopes).toContain('config:write');
      expect(scopes).toContain('documents:delete');
    }
  });
});
