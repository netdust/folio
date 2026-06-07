import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { apiTokens } from '../db/schema.ts';
import { makeTestApp } from '../test/harness.ts';
import {
  effectiveReach,
  isAgentBound,
  isInstanceReach,
  isOperatorToken,
  mintToken,
} from './token-reach.ts';

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
  test('operator ephemeral token (isOperator:true, agentId null, createdBy=caller) is agent-bound', () => {
    expect(
      isAgentBound({ agentId: null, isOperator: true, workspaceId: null, createdBy: 'caller-1' } as any),
    ).toBe(true);
  });
  test('human instance PAT (agentId null, NO isOperator, createdBy set) is NOT agent-bound', () => {
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

// Task 1.3 — mintToken stamps an optional expiry. The column (Task 1.1) is
// enforced at the bearer middleware (Task 1.2); this proves the mint WRITES it.
describe('mintToken expiresInDays (optional token expiry)', () => {
  test('expiresInDays: 30 → the inserted row has expiresAt ~30 days out', async () => {
    const { db, seed } = await makeTestApp();
    const before = Date.now();
    const minted = await mintToken(db, {
      ceilingRole: 'owner',
      scopes: ['documents:read'],
      reach: seed.workspace.id,
      name: 'expiring',
      createdBy: seed.user.id,
      expiresInDays: 30,
    });
    const row = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, minted.id) });
    expect(row).toBeDefined();
    expect(row!.expiresAt).not.toBeNull();
    // ~30 days out: strictly past 29 days, and not absurdly far (sanity ceiling).
    expect(row!.expiresAt!.getTime()).toBeGreaterThan(before + 29 * 86_400_000);
    expect(row!.expiresAt!.getTime()).toBeLessThan(before + 31 * 86_400_000);
  });

  test('no expiresInDays → the inserted row has expiresAt null (forever token, default unchanged)', async () => {
    const { db, seed } = await makeTestApp();
    const minted = await mintToken(db, {
      ceilingRole: 'owner',
      scopes: ['documents:read'],
      reach: seed.workspace.id,
      name: 'forever',
      createdBy: seed.user.id,
    });
    const row = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, minted.id) });
    expect(row).toBeDefined();
    expect(row!.expiresAt).toBeNull();
  });

  // Defense-in-depth (Finding 5): a 0 (or negative) day-count must NOT mint an
  // already-expired token. mintToken is the security primitive — Zod guards the
  // routes, but the primitive guards itself too. expiresInDays:0 ⟹ null (forever),
  // not an expiresAt at-or-before now (which the bearer middleware rejects on first use).
  test('expiresInDays: 0 → expiresAt null (no already-expired token minted)', async () => {
    const { db, seed } = await makeTestApp();
    const minted = await mintToken(db, {
      ceilingRole: 'owner',
      scopes: ['documents:read'],
      reach: seed.workspace.id,
      name: 'zero-days',
      createdBy: seed.user.id,
      expiresInDays: 0,
    });
    const row = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, minted.id) });
    expect(row).toBeDefined();
    expect(row!.expiresAt).toBeNull();
  });
});
