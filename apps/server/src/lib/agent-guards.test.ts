import { describe, expect, test } from 'bun:test';
import type { EphemeralToken } from '../db/schema.ts';
import { mayManageAgentLifecycle } from './agent-guards.ts';

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
