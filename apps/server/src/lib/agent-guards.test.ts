import { describe, expect, test } from 'bun:test';
import type { EphemeralToken } from '../db/schema.ts';
import { assertNotHumanPatForAgentLifecycle, mayManageAgentLifecycle } from './agent-guards.ts';
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
