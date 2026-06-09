import { describe, expect, test } from 'bun:test';
import type { EphemeralToken } from '../db/schema.ts';
import { assertNotHumanPatForAgentLifecycle, mayManageAgentLifecycle } from './agent-guards.ts';
import { roleToScopes } from './agent-schema.ts';
import { mcpRejectHumanPat } from './mcp-errors.ts';

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

// Mitigation 3 (spec threat model): the MCP gate (mcpRejectHumanPat) and the
// HTTP gate (assertNotHumanPatForAgentLifecycle) MUST make the SAME
// agent-lifecycle decision for every token shape — they delegate to the one
// shared predicate, so they agree BY CONSTRUCTION. This test goes RED if a
// future edit re-diverges them (the exact privilege-escalation hole the shared
// predicate exists to prevent).
describe('MCP and HTTP agent-lifecycle gates converge', () => {
  function mcpRejects(t: EphemeralToken): boolean {
    try {
      mcpRejectHumanPat(t);
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

  // NB: mcpRejectHumanPat takes a non-null EphemeralToken (the MCP transport
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
// human PATs holding `agents:write`. The escalation worry is "an admin PAT mints
// an agent WIDER than the admin." That is unreachable BY CONSTRUCTION: the gating
// scope `agents:write` is granted by roleToScopes ONLY to owner/admin, who ALSO
// always hold config:write + documents:delete. So any caller that can pass the
// `agents:write` scope gate already holds the full document-scope set — there is
// no scope an admin could grant a child that the admin lacks. A hand-crafted
// `agents:write`-only PAT is un-mintable (mintToken's roleToScopes ceiling —
// locked by tokens.test.ts:195,213). This test pins the structural fact the
// whole argument rests on; the agent-bound-caller widening path is locked
// separately by mcp.test.ts F2 (allow_list_widening_forbidden / tools-widening).
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
