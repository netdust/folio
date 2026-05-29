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
  /**
   * D-2: MCP-transport metadata. Carried verbatim from the legacy mcp.ts
   * `ToolDef` so D-3's `tools/list` can read it via `listToolDefs()`. The
   * runner ignores these; `executeTool` never touches them.
   */
  description?: string;
  /** JSON Schema advertised by `tools/list`. Advisory only — not validated. */
  inputSchema?: Record<string, unknown>;
}

/** Transport metadata for one registered tool — what `tools/list` advertises. */
export interface ToolListEntry {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

const registry = new Map<string, ToolDef>();

// Test-only teardown hook so test files can delete throwaway registrations
// without reaching into module internals (registry is module-global, so leaked
// registrations would break sibling tests — see the mock-module-leak lesson).
if (process.env.NODE_ENV === 'test') {
  (globalThis as unknown as { __folioToolRegistry?: Map<string, ToolDef> }).__folioToolRegistry =
    registry;
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
 * Return the MCP-transport metadata for every registered tool. D-3's
 * `tools/list` reads this instead of the legacy inline `TOOLS` array. The
 * test-only `__echo` tool is excluded — it must never appear in the public
 * tool list (mitigation 34). Order is registration order (Map preserves it),
 * which keeps `tools/list` output stable across calls.
 */
export function listToolDefs(): ToolListEntry[] {
  const out: ToolListEntry[] = [];
  for (const def of registry.values()) {
    if (def.name === '__echo') continue;
    out.push({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
    });
  }
  return out;
}

/**
 * Dispatch a tool by name through the shared auth model.
 *
 * Order: lookup → call-time `__echo` production gate → scope check →
 * Zod re-validation → handler.
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

  // No agent-lifecycle self/peer gate here. The dispatcher is transport +
  // scope + arg-validation only. Per-tool lifecycle guards (allow-list
  // widening on create/update, self-delete rejection on delete, token-anchored
  // resolution on get_agent_self — see routes/mcp.ts today) are anchored to
  // token.agentId and move into this layer in D-3 with the real handlers.

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

// D-2: register the 20 production tools into the module-global registry. The
// registrations live in a sibling file so this file stays pure dispatch
// infrastructure. `registerRealTools()` is a FUNCTION (not a side-effect
// import) so the circular edge resolves: the registry module imports
// `registerTool` from here, and we only invoke its registrations AFTER this
// module's `const registry` (and `registerTool`) are fully initialized —
// calling at the textual bottom guarantees that. D-3 makes routes/mcp.ts a
// thin transport over `executeTool` + `listToolDefs` and deletes its own
// inline `TOOLS` array.
import { registerRealTools } from './agent-tools-registry.ts';

registerRealTools();
