/**
 * Per-tool DENIAL MATRIX — the authorization convergence-point seam test.
 *
 * Folio's MCP/agent tools all converge their authorization at ONE point:
 * `executeTool` in `agent-tools.ts` (lines 355-357), a DOUBLE membership test —
 * BOTH the agent token AND the caller must hold the tool's `requiredScope` or the
 * call is denied (`forbidden: scope <S> missing`) BEFORE the handler is dispatched.
 *
 * This test is DATA-DRIVEN over the LIVE registry. It enumerates every registered
 * production tool and asserts the scope gate denies BOTH halves of the double
 * membership (caller-missing-scope AND token-missing-scope). Because it iterates
 * the registry rather than a hand-written list, it AUTO-COVERS any future tool —
 * and the coverage-guard assertion at the bottom makes the suite go RED if a new
 * tool is registered but somehow escapes the matrix. The property under lock:
 * **no tool ships un-gated.**
 *
 * WHY denial-only (no allow path per tool): the scope check is BEFORE handler
 * dispatch, so denial is provable WITHOUT invoking handlers (which have real DB /
 * side-effect needs). Denial is the security property; the allow path is exercised
 * tool-by-tool elsewhere. If denial does NOT fire for any tool, that is a REAL
 * security bug, not a test defect.
 *
 * "handler NOT invoked" is proven structurally: the assertion checks the thrown
 * error is the SCOPE-DENIAL message (`forbidden: scope … missing`). A handler that
 * had run would surface a different error (DB miss, validation, success) — so the
 * exact denial message IS the proof the gate fired ahead of dispatch.
 */

import { beforeAll, describe, expect, it } from 'bun:test';
import type { ApiToken } from '../db/schema.ts';
import { type ToolDef, executeTool, initToolRegistry } from './agent-tools.ts';

/**
 * Build a minimal ApiToken stub carrying exactly the supplied scopes. Mirrors the
 * `makeToken` helper in agent-tools.test.ts — only `scopes` is load-bearing for
 * the gate; the rest satisfy the type.
 */
function tokenWithScopes(scopes: string[]): ApiToken {
  return {
    id: 'tok_denial',
    workspaceId: 'ws_test',
    name: 'denial-matrix',
    tokenHash: 'hash',
    scopes,
    agentId: null,
    projectIds: null,
    createdBy: null,
    lastUsedAt: null,
    expiresAt: null,
    createdAt: new Date(),
  };
}

/** The live registry Map, exposed for tests at agent-tools.ts:248. */
function liveRegistry(): Map<string, ToolDef> {
  const reg = (globalThis as unknown as { __folioToolRegistry?: Map<string, ToolDef> })
    .__folioToolRegistry;
  if (!reg) throw new Error('registry not exposed — NODE_ENV must be "test"');
  return reg;
}

/**
 * The test-only tool. It IS in the registry during tests (registered at module
 * load when NODE_ENV==='test'), but it is NOT a production tool and must never
 * appear in the public tool list — so it is excluded from the production-tool
 * matrix and accounted for separately in the coverage guard.
 */
const TEST_ONLY_TOOLS = new Set<string>(['__echo']);

describe('per-tool denial matrix — executeTool scope convergence point (audit 3.7)', () => {
  let tools: ToolDef[];

  beforeAll(() => {
    // Ensure the real tools are registered (lazy-on-first-use otherwise).
    initToolRegistry();
    tools = [...liveRegistry().values()].filter((def) => !TEST_ONLY_TOOLS.has(def.name));
  });

  it('registers a non-trivial production tool set (sanity floor)', () => {
    // Floor guard: if registration silently no-ops, an empty matrix would vacuously
    // "pass". Lock a lower bound so a broken registration is caught loudly.
    expect(tools.length).toBeGreaterThanOrEqual(30);
  });

  it('every production tool declares an explicit requiredScope', () => {
    // The whole gate keys on requiredScope. A tool with no/empty requiredScope
    // would deny against `undefined`/'' — a different failure shape. There are NO
    // always-allowed tools by design (even list_workspaces needs documents:read).
    for (const def of tools) {
      expect(typeof def.requiredScope).toBe('string');
      expect(def.requiredScope.length).toBeGreaterThan(0);
    }
  });

  it('DENIES every production tool when the CALLER lacks the required scope (token has it)', async () => {
    let covered = 0;
    for (const def of tools) {
      const s = def.requiredScope;
      // Token holds S; caller holds nothing → the double-membership gate must deny.
      // The exact scope-denial message proves the gate fired BEFORE handler dispatch
      // (a handler that ran would surface a different error / a result).
      await expect(
        executeTool(tokenWithScopes([s]), 'agent:denial', def.name, {}, undefined, {
          callerScopes: [],
        }),
        `tool "${def.name}" (requiredScope=${s}) did NOT deny when caller lacked the scope`,
      ).rejects.toThrow(`forbidden: scope ${s} missing`);
      covered++;
    }
    expect(covered).toBe(tools.length);
  });

  it('DENIES every production tool when the TOKEN lacks the required scope (caller has it)', async () => {
    let covered = 0;
    for (const def of tools) {
      const s = def.requiredScope;
      // Caller holds S; token holds nothing → the OTHER half of the double gate must
      // deny. Covers both branches of `token.scopes.includes(S) || callerScopes…`.
      await expect(
        executeTool(tokenWithScopes([]), 'agent:denial', def.name, {}, undefined, {
          callerScopes: [s],
        }),
        `tool "${def.name}" (requiredScope=${s}) did NOT deny when the token lacked the scope`,
      ).rejects.toThrow(`forbidden: scope ${s} missing`);
      covered++;
    }
    expect(covered).toBe(tools.length);
  });

  it('DENIES every production tool with NO caller authority supplied (fail-closed, deny-all)', async () => {
    // Missing caller → callerScopes defaults to [] (deny-all). Even a token that
    // holds the scope must be denied: an un-wired call site fails closed, never
    // falls open.
    let covered = 0;
    for (const def of tools) {
      const s = def.requiredScope;
      await expect(
        // No caller arg at all — the un-backfilled / un-wired path.
        executeTool(tokenWithScopes([s]), 'agent:denial', def.name, {}),
        `tool "${def.name}" (requiredScope=${s}) did NOT fail closed with no caller authority`,
      ).rejects.toThrow(`forbidden: scope ${s} missing`);
      covered++;
    }
    expect(covered).toBe(tools.length);
  });

  it('COVERAGE GUARD — the matrix covered every registered tool (no tool ships un-gated)', () => {
    // The negative case for the seam test: if someone registers a new tool, the
    // registry size grows but the matrix above iterates the SAME live set — so the
    // new tool is automatically denial-tested. This guard asserts the accounting:
    // every entry in the live registry is either a covered production tool or an
    // accounted-for test-only tool. A registry entry that is neither = an un-gated
    // tool slipping past the matrix → RED.
    const registry = liveRegistry();
    const accountedFor = new Set<string>([...tools.map((d) => d.name), ...TEST_ONLY_TOOLS]);
    const unaccounted = [...registry.keys()].filter((name) => !accountedFor.has(name));
    expect(unaccounted).toEqual([]);
    // The production matrix + the test-only set together account for the WHOLE
    // registry — the "all tools covered" property, stated as an equality.
    expect(tools.length + TEST_ONLY_TOOLS.size).toBe(registry.size);
  });
});
