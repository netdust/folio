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
import { db } from '../db/client.ts';
import type { DB } from '../db/client.ts';
import type { ApiToken, EphemeralToken } from '../db/schema.ts';
import {
  getConfirmedPendingOp,
  markExecuted,
  recordPendingOp,
} from '../services/pending-ops.ts';
import type { ConversationSink } from './chat-thread-sink.ts';

// Drizzle transaction handles share the query API with DB; one shape works for
// both. Mirrors the (non-exported) `DBOrTx` in lib/events.ts — re-declared here
// rather than imported because events.ts does not export it.
type DBOrTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

/**
 * Thrown by the irreversible-op confirm gate after it records the pending_op and
 * emits the confirmation choice_card. It is NOT a failure: it signals the runner
 * to END THE TURN CLEANLY and wait for the user's approval (the same clean-pause
 * `ask_choice` gets), instead of failing the run. A non-conversation caller (no
 * sink to render the card) never reaches the gate's card path, so this only
 * surfaces on a conversation run where a clean pause is the right outcome.
 *
 * Distinct TYPE (not a `forbidden:` message prefix) so the runner can route it
 * to the clean-pause branch BEFORE `isFatalToolError` — a true scope denial stays
 * fatal; "needs your approval" pauses. `isAwaitingConfirmation` is the guard.
 */
export class AwaitingConfirmationError extends Error {
  readonly awaitingConfirmation = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'AwaitingConfirmationError';
  }
}

export function isAwaitingConfirmation(err: unknown): err is AwaitingConfirmationError {
  return err instanceof AwaitingConfirmationError;
}

export interface ToolContext {
  /**
   * The authority — scopes + agent binding. Typed `EphemeralToken` (not
   * `ApiToken`) so the operator's `isOperator` marker stays TYPE-VISIBLE across
   * this seam: a refactor that reconstructs the token can't silently drop it.
   */
  token: EphemeralToken;
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
  /** Caller-authority snapshot (Phase 1 delegation, mitigation D3). The
   *  run's effective authority is agent ∩ caller. (Project narrowing now lives
   *  in the centrally-narrowed `token.projectIds` from loadContext, not here.) */
  callerScopes: string[];
  /** Phase C C3 — second run-derived field on the gate: true ONLY on a fired
   *  (no-human-in-the-loop) run. The folio_api write handler reads it to floor
   *  MEDIUM-risk config writes to refuse-with-plan. Undefined on non-run
   *  callers (MCP/human) → treated as attended. */
  unattended?: boolean;
  /**
   * Operator cockpit chat (Task 4) — the conversation-thread output sink.
   * Present ONLY on a conversation-backed run (the runner sets it from
   * `makeConversationSink`). The `ui` tools (`show_link_panel`/`ask_choice`)
   * emit a `component` message through this; absent ⇒ a non-chat run called a
   * chat-only tool and the handler fails closed. Undefined on every document-
   * thread / MCP / headless call — zero regression to the existing path.
   */
  conversationSink?: ConversationSink;
  /**
   * Operator cockpit chat (Task 4) — the active conversation id, threaded so
   * the irreversible-op confirm gate (Task 7, Cluster 4) can scope a
   * `pending_ops` row to it. T4 only PLUMBS this; the gate that consumes it
   * lands later. Undefined on non-conversation calls.
   */
  conversationId?: string;
  /**
   * Operator cockpit chat (Task 7, Cluster-4 BLOCKER fix) — the HUMAN confirmer
   * (conversation owner's user id). folio_api owns its OWN confirm gate and must
   * record pending_ops.caller_id with this (the id the confirm route confirms
   * with), NOT `actor` (= agent:_operator). Undefined on non-conversation calls.
   */
  confirmerId?: string;
}

export interface ToolDef<TArgs = unknown, TOut = unknown> {
  name: string;
  /** Scope the token must hold. Plain string — there is no `Scope` type. */
  requiredScope: string;
  schema: z.ZodSchema<TArgs>;
  handler: (args: TArgs, ctx: ToolContext) => Promise<TOut>;
  /**
   * C3 unattended floor (per-tool). When true, this tool is REFUSED on an
   * unattended (trigger-fired, no-human) run — a tool-name-keyed floor for ops
   * the scope-keyed `UNATTENDED_FLOORED_SCOPES` can't express. Used by
   * `set_skill_trust`: it shares `config:write` with `folio_api`, but `folio_api`
   * applies its OWN finer floor (config-class paths refuse, document paths stay
   * allowed unattended — the accepted LOW residual), so a scope-level floor would
   * wrongly kill folio_api's allowed unattended document writes. Flooring by tool
   * name floors trust-elevation without touching that residual.
   */
  unattendedFloor?: boolean;
  /**
   * Operator cockpit chat (Task 7) — the irreversible-op confirm gate's risk
   * tier. Drives the HARD, conversation-scoped confirm gate in `executeTool`
   * (spec: Irreversible-op gate §; threat model M4–M7, M13).
   *
   * FAIL-CLOSED by construction: a tool's EFFECTIVE tier is
   *   `def.riskTier ?? (isWriteOrDeleteScope(def.requiredScope) ? 'high' : 'normal')`
   * So EVERY write/delete-scoped tool DEFAULTS to `high` and confirms in a
   * conversation. A tool opts DOWN to `normal` only by an explicit, reviewed
   * `riskTier: 'normal'` (the same deliberate act that lowers `unattendedFloor`).
   * A NEW unclassified write/delete tool stays `high` → confirms automatically;
   * there is NO destructive-allowlist to remember to extend.
   *
   * NOTE — `folio_api` is special-cased OUT of the dispatcher gate (it carries
   * `config:write` but multiplexes many routes at many tiers). It owns its OWN
   * per-path tiering INSIDE its handler (see folio-api-tool.ts). It is tagged
   * `riskTier: 'normal'` here purely so the dispatcher does not blanket-gate it;
   * its handler raises the SAME pending-op gate for its config-class paths.
   */
  riskTier?: 'high' | 'normal';
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

/**
 * Phase C C3 (review-fix #1) — the unattended floor at the CONVERGENCE POINT.
 *
 * On an unattended (trigger-fired, no-human-in-the-loop) run, any tool whose
 * `requiredScope` is in this set is REFUSED before dispatch. This is the central
 * twin of folio_api's own path-based tier floor: folio_api floors its MEDIUM
 * config:write paths inside its handler; THIS floors HIGH-risk NATIVE tools that
 * never route through folio_api's classifier.
 *
 * Why `agents:write` is here: the six native lifecycle tools
 * (create_agent / update_agent / delete_agent / run_agent / cancel_run /
 * retry_run) MINT or MODIFY standing agent bearer tokens — HIGH-risk. Minting a
 * token unattended with no human floor is exactly what C3 forbids. Putting the
 * check here (not in each handler) means every present and future agents:write
 * tool inherits the floor — the "redact at the loader, not the handler" lesson.
 *
 * Why `documents:write` / `documents:delete` are NOT here: LOW-risk document
 * writes are the DOCUMENTED ACCEPTED RESIDUAL of C3 — an unattended run is meant
 * to auto-apply document edits. Flooring them would break the design.
 *
 * Why `config:write` (folio_api) is NOT here: folio_api does its OWN granular
 * path-based tiering (MEDIUM paths floored, LOW paths auto). Adding config:write
 * here too would double-handle it — redundant-but-harmless, but it muddies
 * ownership. DECISION: folio_api owns config-write flooring; this set owns the
 * native HIGH-risk scopes folio_api can't see.
 */
const UNATTENDED_FLOORED_SCOPES = new Set<string>(['agents:write']);

/**
 * Operator cockpit chat (Task 7) — the fail-closed risk classifier the confirm
 * gate keys on. A MUTATING scope makes a tool DEFAULT to `high`
 * (confirm-in-conversation) unless its def explicitly opts down to
 * `riskTier: 'normal'`. There is NO allowlist: classification is structural.
 *
 * Cluster-4 /code-review fix: the rule is "mutating UNLESS it ends in `:read`",
 * NOT just `:write`/`:delete`. The earlier suffix check missed admin-class scopes
 * that don't follow the `:write` convention — notably `workspace:admin` (and a
 * hypothetical future `admin:purge` / `documents:archive`) would have classified
 * `normal` and SKIPPED the gate. Defaulting everything non-`:read` to mutating is
 * strictly MORE fail-closed: a new mutating scope confirms unless deliberately
 * named `…:read` or opted down. (spec: Irreversible-op gate § —
 * `effectiveTier = def.riskTier ?? (isWriteOrDeleteScope ? 'high' : 'normal')`.)
 */
export function isWriteOrDeleteScope(scope: string): boolean {
  return !scope.endsWith(':read');
}

/**
 * The single name special-cased OUT of the dispatcher-level confirm gate.
 * `folio_api` carries `config:write` (a write scope) but multiplexes MANY routes
 * at MANY tiers — blanket-gating it at the dispatcher would gate every document
 * write routed through it. So it OWNS its own per-path tiering inside its handler
 * (folio-api-tool.ts), which raises the SAME pending-op gate for its config-class
 * paths. Both enforcement points are named so neither is a bypass ("a
 * deterministic bound must name its execution path" — TWO paths here).
 */
const CONFIRM_GATE_SELF_TIERED_TOOLS = new Set<string>(['folio_api']);

/**
 * Resolve a tool's EFFECTIVE confirm-gate risk tier (fail-closed default-to-high
 * for write/delete scopes). The ONE place the tier is decided so the dispatcher
 * gate and any test agree on the rule.
 */
export function effectiveRiskTier(def: ToolDef): 'high' | 'normal' {
  return def.riskTier ?? (isWriteOrDeleteScope(def.requiredScope) ? 'high' : 'normal');
}

/**
 * Best-effort human-readable target for the audit `pending_ops.target` column
 * (the "what was this?" support-path label). NON-load-bearing: the SECURITY
 * binding is the recorded params (M6), not this string. So a heuristic over the
 * common identifier arg keys is fine; it falls back to the op name. It NEVER
 * affects whether the gate fires or what executes.
 */
export function deriveConfirmTarget(name: string, args: unknown): string {
  if (args && typeof args === 'object') {
    const a = args as Record<string, unknown>;
    for (const key of ['slug', 'wslug', 'document_slug', 'id', 'path', 'agent_slug', 'run_id']) {
      const v = a[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
  }
  return name;
}

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
  token: EphemeralToken,
  actor: string,
  name: string,
  args: unknown,
  tx?: DBOrTx,
  caller?: {
    callerScopes: string[];
    unattended?: boolean;
    /** Operator cockpit chat (Task 4) — threaded so a conversation-scoped tool
     *  (the `ui` tools today; the confirm gate in Task 7) can reach the active
     *  conversation. The runner supplies it on a conversation-backed run only. */
    conversationId?: string;
    /** Operator cockpit chat (Task 4) — the conversation output sink, threaded
     *  from the runner so the `ui` tool handlers can emit `component` rows. */
    conversationSink?: ConversationSink;
    /** Operator cockpit chat (Task 7, Cluster-4 /code-review BLOCKER fix) — the
     *  HUMAN who can confirm a pending_op (the conversation owner's user id =
     *  `RunContext.transitionActor`). `actor` is the AGENT identity (`agent:_operator`)
     *  for audit/event purposes, but the confirm ROUTE confirms with the session
     *  user's id, so the pending_op's `caller_id` MUST be recorded with this human
     *  id — not `actor` — or `confirmPendingOp`'s caller-bound WHERE never matches
     *  and every confirmation fails closed (the gate becomes unconfirmable). */
    confirmerId?: string;
  },
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

  // Delegate ceiling (mitigation D3/D9/D10): caller authority FAILS CLOSED.
  // Missing/undefined caller scopes are treated as [] (deny-all), NEVER as
  // wildcard — so an un-wired call site or un-backfilled run denies rather than
  // escalates. Project narrowing is no longer threaded here — it lives in the
  // centrally-narrowed `token.projectIds` from loadContext; only scopes are
  // guarded at this layer.
  const callerScopes = caller?.callerScopes ?? [];

  // Scope check is now a DOUBLE membership test: agent token AND caller must
  // both hold the scope (mitigation D3). Name-only error (mitigation D7).
  if (!token.scopes.includes(def.requiredScope) || !callerScopes.includes(def.requiredScope)) {
    throw new Error(`forbidden: scope ${def.requiredScope} missing`);
  }

  // Phase C C3 (review-fix #1) — the unattended floor at the CONVERGENCE POINT.
  // folio_api floors its own MEDIUM config:write path-tier; this floors HIGH-risk
  // NATIVE tools (agents:write = agent/token lifecycle) that don't route through
  // folio_api's classifier. LOW document writes (documents:write/delete) stay
  // auto — the accepted residual. The model must NOT be able to retry around
  // this, so the message is shaped `forbidden: …` to match runner.ts
  // `isFatalToolError` (which terminates the run, like a scope denial).
  // Scope-keyed floor (agents:write) OR per-tool floor (def.unattendedFloor —
  // set_skill_trust: trust-elevation must not happen on a no-human run over
  // attacker-supplied content; see ToolDef.unattendedFloor). /shakeout 2026-06-03
  // (security + invariant-auditor): without this, a Phase-C trigger firing the
  // operator unattended could bless a planted skill into the trusted channel.
  if (
    caller?.unattended === true &&
    (UNATTENDED_FLOORED_SCOPES.has(def.requiredScope) || def.unattendedFloor === true)
  ) {
    throw new Error(`forbidden: ${name} is refused on an unattended (trigger-fired) run`);
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

  // Operator cockpit chat (Task 7) — the HARD irreversible-op confirm gate at the
  // CONVERGENCE POINT (Inv 2), a sibling of the unattended floor above. NOT a
  // prompt rule (spec: Irreversible-op gate §; threat model M4–M7, M13).
  //
  // Engages ONLY with a conversation context (`caller.conversationId`) — a
  // `pending_ops` row's `conversation_id` is non-null by construction, so the gate
  // is conversation-scoped BY DESIGN. A headless `high`-tier run (trigger / MCP
  // admin) has no `conversationId` → the gate is SKIPPED → it falls back to the
  // existing authority treatment (in-scope → applies). NO regression (M-deferral).
  //
  // TWO enforcement paths (both named — "a deterministic bound names its path"):
  //   1. THIS dispatcher gate covers NATIVE high-tier tools (delete_document,
  //      delete_comment, the agents:write lifecycle, plus any future write/delete
  //      tool that didn't opt down to `riskTier:'normal'`).
  //   2. folio_api owns its OWN per-path gate inside its handler (folio-api-tool.ts)
  //      — it is special-cased OUT here (CONFIRM_GATE_SELF_TIERED_TOOLS) so its
  //      document-write paths aren't blanket-gated by its config:write scope.
  //
  // The parsed args (`parsed`) are the gate's match key. On confirm, the handler
  // runs the RECORDED params (`confirmed.params`), NOT this turn-2 re-read — that
  // is what makes confirm injection-proof (M6).
  let handlerArgs: unknown = parsed;
  if (
    caller?.conversationId &&
    !CONFIRM_GATE_SELF_TIERED_TOOLS.has(name) &&
    effectiveRiskTier(def) === 'high'
  ) {
    const gateDb = tx ?? db;
    const confirmed = await getConfirmedPendingOp(gateDb, {
      conversationId: caller.conversationId,
      op: name,
      params: parsed,
    });
    if (!confirmed) {
      // Record the exact pending action + surface a choice_card, then REFUSE.
      // The HUMAN confirmer (conversation owner) — NOT `actor` (= agent:_operator).
      // The confirm route confirms with the session user's id; caller_id MUST match
      // it or confirmPendingOp's caller-bound WHERE never matches and the gate is
      // unconfirmable (Cluster-4 BLOCKER fix). A conversation gate with no confirmer
      // is a wiring bug — fail LOUD rather than record an unconfirmable op.
      if (!caller.confirmerId) {
        throw new Error('forbidden: confirm gate reached without a confirmer id');
      }
      const pending = await recordPendingOp(gateDb, {
        conversationId: caller.conversationId,
        callerId: caller.confirmerId,
        op: name,
        params: parsed,
        target: deriveConfirmTarget(name, parsed),
      });
      if (caller.conversationSink) {
        // (a) the confirm card — the "yes" id IS the pending_ops.id (M7/M8).
        await caller.conversationSink.component({
          type: 'choice_card',
          prompt: `Confirm ${name}? This is an irreversible action and will not run until you approve it.`,
          options: [
            { id: pending.id, label: 'Yes, do it' },
            { id: 'cancel', label: 'Cancel' },
          ],
          pending_op: pending.id,
        });
        // (b) a VISIBLE tool_step so the NEXT turn's replayed history shows the
        //     confirmation was requested — continuation doesn't depend purely on
        //     server orchestration (threat model attack #4 follow-up).
        await caller.conversationSink.toolStep({
          tool: name,
          summary: 'confirmation required',
          status: 'error',
        });
      }
      // PAUSE — not a failure. The card is emitted + the pending_op recorded;
      // signal the runner to end the turn cleanly and await the user's approval
      // (clean-pause, like ask_choice), NOT failRun. The model cannot retry around
      // the gate (the throw unwinds the tool call regardless).
      throw new AwaitingConfirmationError(`${name} requires confirmation`);
    }
    // Confirmed: execute the RECORDED params (M6), NOT the turn-2 re-read. Re-parse
    // the stored JSON through the SAME schema so the handler still receives a
    // schema-typed value (and a tampered stored row would fail closed).
    handlerArgs = def.schema.parse(JSON.parse(confirmed.params));
    // Mark the audit trail AFTER the handler succeeds (below) — do it here so a
    // handler throw leaves the row 'confirmed' (re-confirm not required; a retry
    // re-runs the same recorded op). Bind the closure to mark on success.
    const result = await def.handler(handlerArgs as never, {
      token,
      actor,
      tx,
      callerScopes,
      unattended: caller?.unattended,
      conversationSink: caller?.conversationSink,
      conversationId: caller?.conversationId,
      confirmerId: caller?.confirmerId,
    });
    await markExecuted(gateDb, confirmed.id, actor);
    return result;
  }

  return def.handler(handlerArgs as never, {
    token,
    actor,
    tx,
    callerScopes,
    // Phase C C3 — flow the run-derived fired marker into ToolContext. Undefined
    // on non-run (MCP/human) callers → the folio_api handler treats it attended.
    unattended: caller?.unattended,
    // Operator cockpit chat (Task 4) — flow the conversation sink + id into
    // ToolContext so the `ui` tool handlers can emit `component` rows. Undefined
    // on every non-conversation call → the `ui` tools fail closed (T3 handler).
    conversationSink: caller?.conversationSink,
    conversationId: caller?.conversationId,
    confirmerId: caller?.confirmerId,
  });
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
