import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';
import type { ApiToken } from '../db/schema.ts';
import { makeTestApp } from '../test/harness.ts';
import { executeTool, registerTool, type ToolDef } from './agent-tools.ts';

/**
 * Build a minimal ApiToken stub. Only the fields executeTool reads
 * (`scopes`, `agentId`) carry meaning here; the rest satisfy the type.
 */
function makeToken(overrides: Partial<ApiToken> = {}): ApiToken {
  return {
    id: 'tok_test',
    workspaceId: 'ws_test',
    name: 'test',
    tokenHash: 'hash',
    scopes: ['documents:read'],
    agentId: null,
    projectIds: null,
    createdBy: null,
    lastUsedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

// Track throwaway registrations so they don't leak into sibling tests/files
// (registry is module-global per the mock-module-leak lesson).
const registeredInTest: string[] = [];
function registerThrowaway<TArgs, TOut>(def: ToolDef<TArgs, TOut>): void {
  registerTool(def);
  registeredInTest.push(def.name);
}

afterEach(() => {
  for (const name of registeredInTest.splice(0)) {
    // @ts-expect-error — test-only registry teardown hook
    (globalThis.__folioToolRegistry as Map<string, unknown>)?.delete(name);
  }
});

describe('executeTool dispatch', () => {
  it('throws "method not found" for an unknown tool name', async () => {
    await expect(executeTool(makeToken(), 'tester', 'nope', {})).rejects.toThrow(
      'method not found: nope',
    );
  });

  it('throws "method not found" for __echo when NODE_ENV !== "test"', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(
        executeTool(makeToken(), 'tester', '__echo', { value: 'hi' }),
      ).rejects.toThrow('method not found: __echo');
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('runs the tool when args parse + scope check pass', async () => {
    const out = await executeTool(makeToken(), 'tester', '__echo', { value: 'hi' });
    expect(out).toEqual({ echoed: 'hi' });
  });

  it('throws MCP_INVALID_ARGS with PATHS only when args fail Zod parse', async () => {
    let invoked = false;
    registerThrowaway({
      name: '__parse_probe',
      requiredScope: 'documents:read',
      schema: z.object({ value: z.string() }).strict(),
      handler: async () => {
        invoked = true;
        return null;
      },
    });

    let thrown: unknown;
    try {
      await executeTool(makeToken(), 'tester', '__parse_probe', { value: 123 });
    } catch (err) {
      thrown = err;
    }

    expect(invoked).toBe(false);
    expect(thrown).toBeInstanceOf(Error);
    const e = thrown as Error & { issues?: Array<{ path: (string | number)[] }> };
    expect(e.message).toBe('MCP_INVALID_ARGS');
    expect(e.issues).toEqual([{ path: ['value'] }]);
    // The offending value (123) must NOT appear anywhere in the payload.
    expect(JSON.stringify(e.issues)).not.toContain('123');
    expect(JSON.stringify({ message: e.message, issues: e.issues })).not.toContain(
      '123',
    );
  });

  it('throws forbidden: scope missing when the token lacks the requiredScope', async () => {
    let invoked = false;
    registerThrowaway({
      name: '__scope_probe',
      requiredScope: 'agents:write',
      schema: z.object({}).strict(),
      handler: async () => {
        invoked = true;
        return null;
      },
    });

    await expect(
      executeTool(makeToken({ scopes: ['documents:read'] }), 'tester', '__scope_probe', {}),
    ).rejects.toThrow('forbidden: scope agents:write missing');
    expect(invoked).toBe(false);
  });

  it('threads the optional tx arg into the handler ctx', async () => {
    const { db } = await makeTestApp();
    let seenTx: unknown = 'unset';
    registerThrowaway({
      name: '__tx_probe',
      requiredScope: 'documents:read',
      schema: z.object({}).strict(),
      handler: async (_args, ctx) => {
        seenTx = ctx.tx;
        return null;
      },
    });

    await db.transaction(async (tx) => {
      await executeTool(makeToken(), 'tester', '__tx_probe', {}, tx);
      expect(seenTx).toBe(tx);
    });
  });

  it('omits tx from the handler ctx when not passed', async () => {
    let seenTx: unknown = 'unset';
    registerThrowaway({
      name: '__notx_probe',
      requiredScope: 'documents:read',
      schema: z.object({}).strict(),
      handler: async (_args, ctx) => {
        seenTx = ctx.tx;
        return null;
      },
    });

    await executeTool(makeToken(), 'tester', '__notx_probe', {});
    expect(seenTx).toBe(undefined);
  });
});

describe('registerTool', () => {
  it('registerTool throws on duplicate name', () => {
    registerThrowaway({
      name: '__dup_probe',
      requiredScope: 'documents:read',
      schema: z.object({}).strict(),
      handler: async () => null,
    });
    expect(() =>
      registerTool({
        name: '__dup_probe',
        requiredScope: 'documents:read',
        schema: z.object({}).strict(),
        handler: async () => null,
      }),
    ).toThrow('tool already registered: __dup_probe');
  });
});

describe('self-vs-peer agent-lifecycle gate', () => {
  function lifecycleProbe(name: string, ran: { value: boolean }): ToolDef {
    return {
      name,
      requiredScope: 'agents:write',
      schema: z.object({ slug: z.string() }).strict(),
      handler: async () => {
        ran.value = true;
        return { ok: true };
      },
    };
  }

  it('rejects agent A calling delete_agent on B with -32602', async () => {
    const ran = { value: false };
    registerThrowaway(lifecycleProbe('delete_agent', ran));

    let thrown: unknown;
    try {
      await executeTool(
        makeToken({ agentId: 'doc_A', scopes: ['agents:write'] }),
        'agent:A',
        'delete_agent',
        { slug: 'B' },
      );
    } catch (err) {
      thrown = err;
    }
    expect(ran.value).toBe(false);
    const e = thrown as Error & { code?: number };
    expect(e.message).toBe('agent_self_management_only');
    expect(e.code).toBe(-32602);
  });

  it('allows agent A calling update_agent on A', async () => {
    const ran = { value: false };
    registerThrowaway(lifecycleProbe('update_agent', ran));

    const out = await executeTool(
      makeToken({ agentId: 'doc_A', scopes: ['agents:write'] }),
      'agent:A',
      'update_agent',
      { slug: 'A' },
    );
    expect(ran.value).toBe(true);
    expect(out).toEqual({ ok: true });
  });

  it('does not gate a human PAT (no agentId) on lifecycle tools', async () => {
    const ran = { value: false };
    registerThrowaway(lifecycleProbe('create_agent', ran));

    const out = await executeTool(
      makeToken({ agentId: null, scopes: ['agents:write'] }),
      'user:somebody',
      'create_agent',
      { slug: 'anything' },
    );
    expect(ran.value).toBe(true);
    expect(out).toEqual({ ok: true });
  });
});
