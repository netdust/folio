import { describe, expect, test } from 'bun:test';
import { effectiveReach, isAgentBound, isInstanceReach, isOperatorToken } from './token-reach.ts';

describe('isInstanceReach', () => {
  test('null workspaceId is instance reach', () => {
    expect(isInstanceReach({ workspaceId: null } as any)).toBe(true);
  });
  test('concrete workspaceId is pinned', () => {
    expect(isInstanceReach({ workspaceId: 'w1' } as any)).toBe(false);
  });
});

describe('isOperatorToken (system-origin operator: instance reach + createdBy null)', () => {
  test('instance reach + createdBy null IS the operator', () => {
    expect(isOperatorToken({ workspaceId: null, createdBy: null } as any)).toBe(true);
  });
  test('instance reach + a human createdBy is NOT the operator (human instance PAT)', () => {
    expect(isOperatorToken({ workspaceId: null, createdBy: 'u1' } as any)).toBe(false);
  });
  test('pinned + createdBy null is NOT the operator', () => {
    expect(isOperatorToken({ workspaceId: 'w1', createdBy: null } as any)).toBe(false);
  });
  test('pinned + human createdBy is NOT the operator', () => {
    expect(isOperatorToken({ workspaceId: 'w1', createdBy: 'u1' } as any)).toBe(false);
  });
});

describe('isAgentBound (the single agent-path-vs-human-path discriminator)', () => {
  test('operator token (agentId null, ws null, createdBy null) is agent-bound', () => {
    expect(isAgentBound({ agentId: null, workspaceId: null, createdBy: null } as any)).toBe(true);
  });
  test('human instance PAT (agentId null, createdBy set) is NOT agent-bound', () => {
    expect(
      isAgentBound({ agentId: null, workspaceId: null, createdBy: 'user-123' } as any),
    ).toBe(false);
  });
  test('human workspace PAT (agentId null, ws set, createdBy set) is NOT agent-bound', () => {
    expect(isAgentBound({ agentId: null, workspaceId: 'ws-1', createdBy: 'user-1' } as any)).toBe(
      false,
    );
  });
  test('workspace agent token (agentId UUID) is agent-bound', () => {
    expect(isAgentBound({ agentId: 'doc-uuid', workspaceId: 'ws-1', createdBy: 'user-1' } as any)).toBe(
      true,
    );
  });
});

describe('effectiveReach (tokenReach ∩ callerReach)', () => {
  test('instance ∩ B = B (member triggers operator)', () => {
    expect(effectiveReach(null, 'B')).toEqual({ ok: true, workspaceId: 'B' });
  });
  test('instance ∩ instance = instance (admin trigger)', () => {
    expect(effectiveReach(null, null)).toEqual({ ok: true, workspaceId: null });
  });
  test('pinned B ∩ B = B', () => {
    expect(effectiveReach('B', 'B')).toEqual({ ok: true, workspaceId: 'B' });
  });
  test('pinned B ∩ null caller = B (unbounded caller keeps the pin)', () => {
    expect(effectiveReach('B', null)).toEqual({ ok: true, workspaceId: 'B' });
  });
  test('pinned B ∩ C = DENY', () => {
    expect(effectiveReach('B', 'C')).toEqual({ ok: false });
  });
});
