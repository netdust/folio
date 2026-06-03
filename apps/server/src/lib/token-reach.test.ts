import { describe, expect, test } from 'bun:test';
import { effectiveReach, isInstanceReach, isOperatorToken } from './token-reach.ts';

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
