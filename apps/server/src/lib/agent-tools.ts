/**
 * Shared in-process tool-execution layer.
 *
 * `executeTool` is the ONE dispatch+auth point that both transport faces call:
 * the MCP route (JSON-RPC over HTTP) and the agent runner (in-process, no
 * self-HTTP). Inside-agent === outside-agent: a single registry, a single auth
 * model. MCP is just one transport over this layer; the runner calls
 * `executeTool` directly.
 *
 * C-7 ships the SKELETON only — one test-only tool (`__echo`). The real tool
 * set is registered in D-3 via `registerTool`. Public surface here
 * (`executeTool`, `registerTool`, `ToolDef`, `ToolContext`) is the stable
 * contract C-8 (runner) and D-3 (real tools) build on.
 */

import { z } from 'zod';
import type { DB } from '../db/client.ts';
import type { ApiToken } from '../db/schema.ts';

// Drizzle transaction handles share the query API with DB; one shape works for
// both. Mirrors the (non-exported) `DBOrTx` in lib/events.ts — re-declared here
// rather than imported because events.ts does not export it.
type DBOrTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

export interface ToolContext {
  /** The authority — scopes + agent binding. */
  token: ApiToken;
  /**
   * The caller's identity for audit/event-actor purposes. For agent callers
   * this is the agent's slug (optionally `agent:<slug>`-prefixed); the runner
   * and MCP route both know the slug at call time and pass it in. (Option (a)
   * from the C-7 reconciliation: token carries authority, actor carries
   * identity — no DB lookup inside this layer.)
   */
  actor: string;
  /** Optional ambient transaction the handler should join, if any. */
  tx?: DBOrTx;
}

export interface ToolDef<TArgs = unknown, TOut = unknown> {
  name: string;
  /** Scope the token must hold. Plain string — there is no `Scope` type. */
  requiredScope: string;
  schema: z.ZodSchema<TArgs>;
  handler: (args: TArgs, ctx: ToolContext) => Promise<TOut>;
}

const registry = new Map<string, ToolDef>();

// Test-only teardown hook so test files can delete throwaway registrations
// without reaching into module internals (registry is module-global, so leaked
// registrations would break sibling tests — see the mock-module-leak lesson).
if (process.env.NODE_ENV === 'test') {
  (globalThis as unknown as { __folioToolRegistry?: Map<string, ToolDef> }).__folioToolRegistry =
    registry;
}

// Agent-lifecycle tools are self-management only: an agent may only act on its
// own document, never on a peer agent (mitigation 27).
const AGENT_LIFECYCLE_TOOLS = new Set([
  'create_agent',
  'update_agent',
  'delete_agent',
  'get_agent_self',
]);

/** Strip an optional `agent:` prefix to get the bare slug from an actor label. */
function slugFromActor(actor: string): string {
  return actor.startsWith('agent:') ? actor.slice('agent:'.length) : actor;
}

/**
 * Register `__echo` ONLY in the test environment. The gate is checked at module
 * load AND `executeTool` re-checks `NODE_ENV` at call time for lifecycle/echo
 * safety: because the registry is built once at load, toggling `NODE_ENV` after
 * import cannot unregister `__echo`. The call-time guard in `executeTool` is
 * what makes the production-path rejection honest — a runtime call to `__echo`
 * when `NODE_ENV !== 'test'` is rejected as `method not found` (mitigation 34).
 */
if (process.env.NODE_ENV === 'test') {
  registry.set('__echo', {
    name: '__echo',
    requiredScope: 'documents:read',
    schema: z.object({ value: z.string() }).strict(),
    handler: async (args) => ({ echoed: (args as { value: string }).value }),
  });
}

/**
 * Register a tool. Forward-compat for D-3, which wires the real tool set.
 * Throws on duplicate names so a double-registration is a loud failure.
 */
export function registerTool<TArgs, TOut>(def: ToolDef<TArgs, TOut>): void {
  if (registry.has(def.name)) {
    throw new Error(`tool already registered: ${def.name}`);
  }
  registry.set(def.name, def as ToolDef);
}

/**
 * Dispatch a tool by name through the shared auth model.
 *
 * Order: lookup → call-time `__echo` production gate → scope check →
 * self-vs-peer lifecycle gate → Zod re-validation → handler.
 */
export async function executeTool(
  token: ApiToken,
  actor: string,
  name: string,
  args: unknown,
  tx?: DBOrTx,
): Promise<unknown> {
  const def = registry.get(name);
  if (!def) throw new Error(`method not found: ${name}`);

  // Call-time production gate for the test-only tool: even if `__echo` is in
  // the registry (it was registered at load when NODE_ENV was 'test'), reject
  // it as unknown whenever the *current* env is not test. This is the path the
  // "throws method not found for __echo when NODE_ENV !== test" test exercises.
  if (name === '__echo' && process.env.NODE_ENV !== 'test') {
    throw new Error(`method not found: ${name}`);
  }

  // Scope check — mirrors `requireScope` in middleware/bearer.ts.
  if (!token.scopes.includes(def.requiredScope)) {
    throw new Error(`forbidden: scope ${def.requiredScope} missing`);
  }

  // Self-vs-peer gate (mitigation 27): an agent-bound token may only target its
  // own slug on the lifecycle tools. Human PATs (no agentId) are not gated.
  if (token.agentId && AGENT_LIFECYCLE_TOOLS.has(name)) {
    const targetSlug =
      typeof args === 'object' && args !== null
        ? (args as { slug?: unknown }).slug
        : undefined;
    if (typeof targetSlug === 'string' && targetSlug !== slugFromActor(actor)) {
      const e = new Error('agent_self_management_only') as Error & { code: number };
      e.code = -32602;
      throw e;
    }
  }

  // Zod re-validation. On failure, surface PATHS only — never values
  // (mitigation 26 + 28: a rejected arg value must not leak into the error).
  let parsed: unknown;
  try {
    parsed = def.schema.parse(args);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.issues.map((i) => ({ path: i.path }));
      const e = new Error('MCP_INVALID_ARGS') as Error & { issues: typeof issues };
      e.issues = issues;
      throw e;
    }
    throw err;
  }

  return def.handler(parsed as never, { token, actor, tx });
}
