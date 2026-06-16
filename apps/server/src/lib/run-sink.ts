/**
 * M2 RunSink refactor (audit 2.6/H10) — Cluster A (A-1/A-2).
 *
 * The runner today threads a turn's output, lifecycle, token-tracking, and
 * cancel handling through a scatter of `if (ctx.sink)` checks (one per concern:
 * `postAgentComment`, `postResultAndComplete`, the token branch, the budget-exit
 * double-post, `wasCancelled`, `handleCancel`, `failRun`). Each check picks the
 * conversation branch when `ctx.sink` is set and the document branch otherwise.
 *
 * This file lifts those two branches into ONE polymorphic abstraction — a
 * `RunSink` with a document implementation (`makeDocumentRunSink`) and a
 * conversation implementation (`makeConversationRunSink`). Each method reproduces
 * EXACTLY today's corresponding branch, byte-for-byte; this is a
 * behavior-preserving refactor, not an improvement. NOTHING is wired here — the
 * runner is rewired in a later task to call these instead of branching inline.
 *
 * The conversation implementation COMPOSES `makeConversationSink(db, …)` — the
 * existing `messages`-row sink — it does not reimplement it; and it exposes that
 * same instance via `conversationSink` so the `ui` tools (Cluster C) can reach
 * `.component(...)` through it.
 *
 * Why no `runner.ts` import: `RunContext` is exported from `runner.ts` but a
 * VALUE import would create a runtime cycle (runner imports this file later).
 * `import type` is erased at compile time, so the type can be pulled cycle-free —
 * verified: the only runner symbol used here is the `RunContext` TYPE.
 */

import { db } from '../db/client.ts';
import { incrementTokens, transitionRun } from '../services/agent-runs.ts';
import { createComment, listComments } from '../services/comments.ts';
import type { AgentRunFrontmatter, RunDoneReason } from './agent-run-schema.ts';
import { runErrorReasonSchema } from './agent-run-schema.ts';
import { type ConversationSink, type ToolStep, makeConversationSink } from './chat-thread-sink.ts';
import type { RunContext } from './runner.ts';

// Re-export so callers can name the param shape from `run-sink.ts` directly.
// The canonical definition lives in `chat-thread-sink.ts` (the leaf module) to
// avoid a runtime import cycle.
export type { ToolStep };

/**
 * The runner's per-turn output + lifecycle abstraction. Each method maps to one
 * `if (ctx.sink)` branch in today's `runner.ts`. The document implementation is
 * today's NON-sink branch; the conversation implementation is today's sink
 * branch. The two are interchangeable from the runner's point of view.
 */
export interface RunSink {
  /**
   * Post a turn's prose output (`postAgentComment`). doc → `createComment` on the
   * parent (`kind` = `comment`/`result`); conv → one `text` message row. `kind`
   * is meaningful only on the document thread.
   */
  post(body: string, kind: 'result' | 'comment'): Promise<void>;
  /**
   * Emit one executed tool-call summary. doc → NO-OP (the document path never
   * emits a tool_step today); conv → one `tool_step` message row.
   */
  toolStep(step: ToolStep): Promise<void>;
  /**
   * Track this round's token usage and return the post-increment running totals
   * (used directly by the budget-cap check — FIX #10). doc → persists via
   * `incrementTokens` (async UPDATE-then-read on the agent_run row); conv →
   * accumulates in an in-memory closure that PERSISTS across calls (mitigation 3
   * — no per-call reset), since a conversation run has no agent_run row.
   *
   * DIVERGENCE FROM PLAN: the plan typed this `{ … }` (sync). It cannot be sync —
   * the document implementation must `await incrementTokens` (today's call at
   * runner.ts:1270 is `await`ed). So the contract is `Promise<{ … }>`; the
   * conversation implementation is synchronous internally but returns the same
   * shape inside the promise.
   */
  trackTokens(addIn: number, addOut: number): Promise<{ tokensIn: number; tokensOut: number }>;
  /**
   * Lifecycle: mark the run completed. doc → `transitionRun(completed)` with the
   * done_reason folded in; conv → NO-OP (a conversation run has no agent_run row;
   * the `active_run_id` slot is its liveness record). NOTE: posting the final
   * `result` text is the CALLER's job (a separate `post('result')` call) — this
   * method is ONLY the lifecycle transition half of today's
   * `postResultAndComplete`.
   */
  complete(doneReason: RunDoneReason | undefined): Promise<void>;
  /**
   * Lifecycle: mark the run failed. doc → `transitionRun(failed)` with the reason
   * + detail; conv → ONE `text` message carrying the detail (the single failure
   * surface — this is what structurally prevents the double-post bug). Reproduces
   * today's `failRun`.
   */
  fail(reason: NonNullable<AgentRunFrontmatter['error_reason']>, detail: string): Promise<void>;
  /**
   * Was this run cancelled mid-flight? doc → scan post-start `rejection` comments
   * with the INCLUSIVE `>= started_at` boundary (FIX #1, security-load-bearing);
   * conv → `false` (mid-turn chat cancel is a v1 deferral).
   */
  wasCancelled(): Promise<boolean>;
  /**
   * Handle a detected cancel. doc → post a partial-work `comment` AND
   * `fail(cancelled)`; conv → `fail(cancelled)` only (one `text` message — both
   * would double-post). Reproduces today's `handleCancel`.
   */
  cancel(): Promise<void>;
  /** `false` for the document sink; `true` for the conversation sink. */
  readonly isConversation: boolean;
  /**
   * The composed `ConversationSink` (conv) or `undefined` (doc). The SAME instance
   * the conversation methods use internally — exposed so the `ui` tools can reach
   * `.component(...)` through it (the Cluster C bridge into `executeTool`).
   */
  readonly conversationSink: ConversationSink | undefined;
}

/**
 * Document-thread implementation: each method reproduces today's NON-sink
 * (`!ctx.sink`) branch in `runner.ts`.
 */
export function makeDocumentRunSink(ctx: RunContext): RunSink {
  // Built into a named `self` (not returned anonymously) so intra-object calls —
  // `cancel` → `self.post`/`self.fail` — bind to the object directly, NOT via
  // `this`. A destructure (`const { cancel } = sink`) or method-reference pass
  // would lose a `this` binding and throw on the security-load-bearing cancel
  // path; `self` removes that hazard while preserving exact call shapes.
  const self: RunSink = {
    // postAgentComment, no-sink branch (runner.ts:1885-1893).
    async post(body: string, kind: 'result' | 'comment'): Promise<void> {
      await createComment({
        workspace: ctx.workspace,
        project: ctx.project,
        parent: ctx.parent,
        authorContext: ctx.authorContext,
        actor: ctx.actor,
        body,
        kind,
      });
    },
    // The document path never emits a tool_step today (the 3 emits are sink-only).
    async toolStep(_step: ToolStep): Promise<void> {
      // NO-OP — see interface doc.
    },
    // The non-sink token branch (runner.ts:1270-1272). FIX #10: incrementTokens
    // returns the post-increment totals atomically; map snake_case → camelCase.
    async trackTokens(
      addIn: number,
      addOut: number,
    ): Promise<{ tokensIn: number; tokensOut: number }> {
      const { tokens_in, tokens_out } = await incrementTokens(ctx.run.id, {
        in: addIn,
        out: addOut,
      });
      return { tokensIn: tokens_in, tokensOut: tokens_out };
    },
    // postResultAndComplete, transition half (runner.ts:1829-1833).
    async complete(doneReason: RunDoneReason | undefined): Promise<void> {
      await transitionRun(ctx.run.id, {
        newStatus: 'completed',
        actor: ctx.transitionActor,
        doneReason,
      });
    },
    // failRun, no-sink branch (runner.ts:2055-2060).
    async fail(
      reason: NonNullable<AgentRunFrontmatter['error_reason']>,
      detail: string,
    ): Promise<void> {
      await transitionRun(ctx.run.id, {
        newStatus: 'failed',
        actor: ctx.transitionActor,
        errorReason: reason,
        errorDetail: detail,
      });
    },
    // wasCancelled, no-sink branch (runner.ts:1920-1925). FIX #1 — the INCLUSIVE
    // `>= startedMs` boundary is copied EXACTLY (it is security-load-bearing: a
    // rejection stamped in the SAME millisecond as started_at is a valid mid-run
    // cancel that listComments' strict `>` `since` filter would drop).
    async wasCancelled(): Promise<boolean> {
      const rejections = await listComments({
        parentId: ctx.parent.id,
        kind: 'rejection',
      });
      const startedMs = new Date(ctx.fm.started_at).getTime();
      return rejections.some((c) => new Date(c.createdAt).getTime() >= startedMs);
    },
    // handleCancel, no-sink branch (runner.ts:1950-1951): partial-work comment
    // PLUS the failed/cancelled transition.
    async cancel(): Promise<void> {
      await self.post('Cancelled by user — partial work above.', 'comment');
      await self.fail(runErrorReasonSchema.enum.cancelled, 'Cancelled by user via comment.');
    },
    isConversation: false,
    conversationSink: undefined,
  };
  return self;
}

/**
 * Conversation-thread implementation: each method reproduces today's sink
 * (`ctx.sink`) branch in `runner.ts`. COMPOSES `makeConversationSink` — the
 * existing `messages`-row sink — rather than reimplementing it.
 *
 * `ctx.conversationId` is guaranteed present on a conversation-backed run (it is
 * stamped alongside the sink by loadContext — see the RunContext doc + the
 * conversationId invariant in runner.ts). Fail LOUD if it is absent rather than
 * compose a sink bound to `undefined`.
 */
export function makeConversationRunSink(ctx: RunContext): RunSink {
  const conversationId = ctx.conversationId;
  if (conversationId === undefined) {
    throw new Error('makeConversationRunSink: a conversation run must carry ctx.conversationId');
  }
  // Use the module-global `db` (NOT a `ctx.db` — RunContext has no such field;
  // ground-truth at runner.ts:756 builds the sink from the imported `db`). The
  // proxy re-resolves to the test DB under makeTestApp, identical to today.
  const sink = makeConversationSink(db, conversationId, ctx.run.id);

  // mitigation 3 — the token accumulator is created ONCE per factory call so
  // multi-round usage ACCUMULATES across trackTokens calls (do NOT reset per
  // call). Mirrors today's `conversationTokens` closure in runAgent.
  const acc = { in: 0, out: 0 };

  // Built into a named `self` (not returned anonymously) so `cancel` → `self.fail`
  // binds to the object directly, NOT via `this` — a destructure or
  // method-reference pass on the security-load-bearing cancel path can't lose a
  // `this` binding and throw. Exact call shapes are unchanged.
  const self: RunSink = {
    // postAgentComment, sink branch (runner.ts:1882).
    async post(body: string, _kind: 'result' | 'comment'): Promise<void> {
      await sink.text(body);
    },
    // The 3 sink-only tool_step emits (runner.ts:1412/1461/1489).
    async toolStep(step: ToolStep): Promise<void> {
      await sink.toolStep(step);
    },
    // The sink token branch (runner.ts:1271) → trackConversationTokens
    // (runner.ts:1003-1011): accumulate in memory, return the running totals.
    async trackTokens(
      addIn: number,
      addOut: number,
    ): Promise<{ tokensIn: number; tokensOut: number }> {
      acc.in += addIn;
      acc.out += addOut;
      return { tokensIn: acc.in, tokensOut: acc.out };
    },
    // postResultAndComplete, sink branch (runner.ts:1826 `if (ctx.sink) return`):
    // the slot is liveness; no transition.
    async complete(_doneReason: RunDoneReason | undefined): Promise<void> {
      // NO-OP — see interface doc.
    },
    // failRun, sink branch (runner.ts:2049): ONE text message carries the detail —
    // the single failure surface (structurally kills the double-post bug).
    async fail(
      _reason: NonNullable<AgentRunFrontmatter['error_reason']>,
      detail: string,
    ): Promise<void> {
      await sink.text(`The operator could not finish this turn: ${detail}`);
    },
    // wasCancelled, sink branch (runner.ts:1911): mid-turn chat cancel is a v1
    // deferral, so report false.
    async wasCancelled(): Promise<boolean> {
      return false;
    },
    // handleCancel, sink branch (runner.ts:1942-1948): fail() ONLY (one text
    // message) — posting a comment AND failing would double-post on the thread.
    async cancel(): Promise<void> {
      await self.fail(
        runErrorReasonSchema.enum.cancelled,
        'Cancelled by user — partial work above.',
      );
    },
    isConversation: true,
    conversationSink: sink,
  };
  return self;
}
