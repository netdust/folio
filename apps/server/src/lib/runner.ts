/**
 * Phase 3 Sub-phase C.2 — Task C-8: the agent runner core loop.
 *
 * `runAgent({runId})` is the heart of the runner. Invariant on entry: the
 * agent_run row is at `status='running'` with `worker_started_at` set (the
 * poller already claimed it via `claimNextPlanningRun` in C-3). This function
 * does NOT claim — it loads context, runs six belt-and-suspenders pre-flight
 * checks, then drives the provider stream in an outer round-loop, executing
 * tool calls via the shared `executeTool` dispatcher and feeding results back
 * through message history.
 *
 * Contract: `runAgent` NEVER throws out. Every failure path transitions the
 * run to a terminal state via `transitionRun` and returns. The poller must
 * not crash on a single bad run.
 *
 * Tx discipline: the runner holds NO transaction across the stream. Each
 * mutation (`transitionRun`, `incrementTokens`, `createComment`) opens its own
 * `txWithEvents`. `executeTool` is called with `tx=undefined` so each tool gets
 * its own short-lived transaction (mitigation 35).
 *
 * Threat-model mitigations bound here: 25 (no wiki-link expansion), 28
 * (sanitized error_detail), 30 (rate limit), 31 (chain guards), 40 (atomic
 * transition), 41 (depth cap), 44 (cancel-via-comment), 47 (idempotency).
 */

import { and, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../db/client.ts';
import { env } from '../env.ts';
import {
  type ApiToken,
  type Document,
  type Project,
  type Workspace,
  aiKeys,
  apiTokens,
  documents,
  projects as projectsTable,
  workspaces,
} from '../db/schema.ts';
import {
  type ProviderName,
  checkChainGuards,
  checkProviderHealth,
  checkRunRateLimits,
  getActiveRun,
  incrementTokens,
  setRunBody,
  transitionRun,
} from '../services/agent-runs.ts';
import { runClaudeCode, type SpawnFn } from './cc-executor.ts';
import { type AuthorContext, createComment, listComments } from '../services/comments.ts';
import {
  type AgentRunFrontmatter,
  type RunDoneReason,
  runErrorReasonSchema,
} from './agent-run-schema.ts';
import { executeTool } from './agent-tools.ts';
import { type Message, type ToolDef, getProvider } from './ai/provider.ts';
import { sanitizeProviderError } from './ai/sanitize-error.ts';
import { newApiToken } from './auth.ts';
import { decryptSecret } from './crypto.ts';
import { HTTPError } from './http.ts';

/**
 * Hard cap on outer provider rounds (one provider call + one tool-result
 * feedback = one round). This is the CHAIN-GUARD for a single run's tool
 * loop, NOT `max_delegation_depth` (cross-run fanout). A run that asks for a
 * tool 25 times without ever terminating is treated as a runaway loop and
 * failed with `chain_guard`.
 */
const MAX_TOOL_ROUNDS = 25;

/**
 * Sub-cap on CONSECUTIVE all-error tool rounds (mitigation 64). Distinct from
 * MAX_TOOL_ROUNDS (the outer runaway backstop): a model that keeps calling a
 * tool with bad args / a tool that keeps throwing recoverably will, post-D-9.2,
 * have each error fed back so it can adapt. This bounds how many times in a row
 * it may fail WITHOUT making any progress (zero successful tool results in the
 * round) before the run is failed with `tool_error`. A round with ≥1 success
 * resets the counter (the model moved forward). Hardcoded at 3 — NOT
 * env-configurable.
 */
const MAX_CONSECUTIVE_TOOL_ERRORS = 3;

/**
 * Provider-name → capitalized label for `sanitizeProviderError`. Matches the
 * casing used at existing call sites (e.g. anthropic.ts passes 'Anthropic').
 */
const PROVIDER_LABELS: Record<ProviderName, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
};

// Test-only spawn override for the claude-code branch (mirrors provider.ts's
// __INTERNAL_TEST_ONLY__ hatch).
let __ccSpawnOverride: SpawnFn | undefined;
export function __setCcSpawnForTest(fn: SpawnFn | undefined): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__setCcSpawnForTest is test-only and must not be called in production');
  }
  __ccSpawnOverride = fn;
}

// ---------------------------------------------------------------------------
// Loaded context
// ---------------------------------------------------------------------------

interface RunContext {
  run: Document;
  fm: AgentRunFrontmatter;
  /** Guaranteed non-null: loadContext returns null when run.parentId is absent. */
  parentId: string;
  parent: Document;
  agent: Document;
  agentFm: Record<string, unknown>;
  workspace: Workspace;
  project: Project;
  token: ApiToken;
  /** `agent:<slug>` — used for executeTool + createComment event actors. */
  actor: string;
  /**
   * FK-valid user id for `transitionRun`'s `updatedBy` write.
   *
   * DIVERGENCE from the plan's `actor:'system:runner'`: `documents.updated_by`
   * has a FK to `users.id`, so a free-form `system:runner` string violates the
   * constraint (confirmed by the agent-runs.test.ts note at L447-451). No
   * system user is seeded at boot. The run's `created_by` (the user who owns
   * the run) is the closest FK-valid provenance; `transitionRun` writes it to
   * both `updated_by` AND the emitted event actor. When a future schema change
   * drops the FK or seeds a system user, swap this to `'system:runner'`.
   */
  transitionActor: string;
  authorContext: AuthorContext;
  apiKey: string;
  baseUrl: string | undefined;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runAgent(args: { runId: string }): Promise<void> {
  const { runId } = args;

  // Load context up-front. A load failure (missing row / missing related doc)
  // is unrecoverable — fail the run defensively, then return. We resolve the
  // provider label lazily once the run fm is known; before that, fall back to
  // a neutral label.
  let providerLabel = 'AI';
  try {
    const ctx = await loadContext(runId);
    if (ctx === null) {
      // Run row itself is gone — nothing to transition. Log + return.
      console.error(`[runner] run ${runId} not found or missing context; skipping`);
      return;
    }
    providerLabel = PROVIDER_LABELS[ctx.fm.provider as ProviderName] ?? 'Claude Code';

    // --- pre-flight checks (cheapest first); each returns true if it BLOCKED.
    if (await preflight(ctx)) return;

    // --- stream consumption (outer round-loop). buildInitialMessages is
    // called HERE (not inside runLoop) so runLoop is reusable by
    // runAgentResume, which builds a different message history.
    if (ctx.fm.provider === 'claude-code') {
      await ccExecute(ctx);
    } else {
      const messages = await buildInitialMessages(ctx);
      await runLoop(ctx, messages);
    }
  } catch (err) {
    // Top-level containment. Any unhandled throw → fail the run with a
    // sanitized detail. If the last-resort transition itself races (run
    // already terminal), swallow + return. Never propagate to the poller.
    await failRunLastResort(runId, providerLabel, err);
  }
}

/**
 * Resume entry point — invoked when the poller claims a planning row whose
 * `frontmatter.resume_of` is set (an approved-plan resume). The run-under-load
 * is the NEW resuming row (already at `running`, claimed by the poller); its
 * `resume_of` points at the ORIGINAL `awaiting_approval` run.
 *
 * Same top-level containment contract as `runAgent`: never throws out; every
 * failure path transitions the resuming run terminal via failRunLastResort.
 *
 * Belt-and-suspenders idempotency guard (mitigation 47): the trigger handler
 * (C.3) only creates a resuming row when the original is awaiting_approval, but
 * if the original is observed in any OTHER status here (already terminal, or
 * raced to running), we do NOT continue — the resuming run is failed with
 * `idempotency_violation` and the provider is never called.
 *
 * TODO(claude-code): this resume path does NOT branch to ccExecute — it always
 * calls runLoop → getProvider(fm.provider), which throws "Unknown AI provider"
 * for `claude-code` (it's intentionally absent from the provider REGISTRY).
 * Unreachable today (no production code transitions a claude-code run into
 * awaiting_approval, and resume_of is not client-settable), but the moment the
 * deferred planning→awaiting_approval gate is wired, an approved claude-code run
 * will crash here. When that lands, mirror runAgent's branch:
 *   if (ctx.fm.provider === 'claude-code') { await ccExecute(ctx); return; }
 */
export async function runAgentResume(args: { runId: string }): Promise<void> {
  const { runId } = args;

  let providerLabel = 'AI';
  try {
    const ctx = await loadContext(runId);
    if (ctx === null) {
      console.error(`[runner] resume run ${runId} not found or missing context; skipping`);
      return;
    }
    providerLabel = PROVIDER_LABELS[ctx.fm.provider as ProviderName] ?? 'Claude Code';

    // Locate the original run via resume_of. Missing pointer or non-existent
    // target → idempotency_violation (the resume contract is broken).
    const originalId = ctx.fm.resume_of;
    const original = originalId
      ? await db.query.documents.findFirst({
          where: and(eq(documents.id, originalId), eq(documents.type, 'agent_run')),
        })
      : undefined;
    if (!original) {
      await failRun(
        ctx,
        runErrorReasonSchema.enum.idempotency_violation,
        'Resume target run not found.',
      );
      return;
    }
    const originalFm = original.frontmatter as AgentRunFrontmatter;
    if (originalFm.status !== 'awaiting_approval') {
      await failRun(
        ctx,
        runErrorReasonSchema.enum.idempotency_violation,
        `Resume target is at status '${originalFm.status}', not awaiting_approval.`,
      );
      return;
    }

    // Same pre-flight gate as a fresh run (rate limits, chain guards, etc.),
    // but exclude the original run from step 6's idempotency check — it is the
    // lineage being resumed, not a competing peer. `original.id` and
    // `ctx.fm.resume_of` are the same id; use the loaded row's id directly.
    if (await preflight(ctx, original.id)) return;

    // Build the resume message history, then delegate to the SHARED loop.
    const messages = await buildResumeMessages(ctx);
    await runLoop(ctx, messages);
  } catch (err) {
    await failRunLastResort(runId, providerLabel, err);
  }
}

// ---------------------------------------------------------------------------
// Context loading
// ---------------------------------------------------------------------------

async function loadContext(runId: string): Promise<RunContext | null> {
  const run = await db.query.documents.findFirst({
    where: and(eq(documents.id, runId), eq(documents.type, 'agent_run')),
  });
  if (!run) return null;

  const fm = run.frontmatter as AgentRunFrontmatter;

  if (!run.parentId) return null;
  const parentId = run.parentId;
  const parent = await db.query.documents.findFirst({
    where: eq(documents.id, parentId),
  });
  if (!parent) return null;

  // The agent is resolved by slug within the run's workspace.
  const agent = await db.query.documents.findFirst({
    where: and(
      eq(documents.workspaceId, run.workspaceId),
      eq(documents.type, 'agent'),
      eq(documents.slug, fm.agent_slug),
    ),
  });
  if (!agent) return null;
  const agentFm = agent.frontmatter as Record<string, unknown>;

  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, run.workspaceId),
  });
  if (!workspace) return null;

  if (!run.projectId) return null;
  const project = await db.query.projects.findFirst({
    where: eq(projectsTable.id, run.projectId),
  });
  if (!project) return null;

  // The agent's auto-minted API token (with scopes) for executeTool.
  const token = await db.query.apiTokens.findFirst({
    where: eq(apiTokens.agentId, agent.id),
  });
  if (!token) return null;

  const actor = `agent:${agent.slug}`;
  // FK-valid actor for transitionRun (see RunContext.transitionActor). Prefer
  // the run's owner; fall back to the agent's creator.
  //
  // FIX #9 — no empty-string fallback. `documents.updated_by` has a FK to
  // `users.id`; an empty string violates it and would strand the run at
  // running. If neither the run nor the agent carries an FK-valid creator,
  // treat it like a missing-context failure: return null so runAgent logs +
  // returns, leaving the run for orphan-recovery. Unreachable in C.2 (createRun
  // always stamps an FK-valid owner); this is a C.3 obligation when other
  // create paths land.
  const transitionActor = run.createdBy ?? agent.createdBy;
  if (!transitionActor) {
    return null;
  }
  const authorContext: AuthorContext = {
    type: 'agent',
    agentSlug: agent.slug,
    agentId: agent.id,
  };

  // BYOK key for the run's snapshotted provider. Absent key is a pre-flight
  // failure (no_ai_key), not a load failure — but resolve it here so the
  // pre-flight check is a pure read. Carry undefined through when missing.
  // claude-code has no API key row; cast is safe — the DB column only holds
  // the 4 API providers, so the query simply returns undefined for claude-code.
  const keyRow = await db.query.aiKeys.findFirst({
    where: and(eq(aiKeys.workspaceId, run.workspaceId), eq(aiKeys.provider, fm.provider as ProviderName)),
  });
  const apiKey = keyRow ? decryptSecret(keyRow.encryptedKey) : '';
  const baseUrl = keyRow?.baseUrl ?? undefined;

  return {
    run,
    fm,
    parentId,
    parent,
    agent,
    agentFm,
    workspace,
    project,
    token,
    actor,
    transitionActor,
    authorContext,
    apiKey,
    baseUrl,
  };
}

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------

/**
 * Six belt-and-suspenders checks, cheapest first. Returns true if a check
 * BLOCKED (the run was transitioned to failed and the caller must return).
 * None of these throw.
 *
 * `excludeRunId` (optional) — a sibling run id to drop from step 6's
 * idempotency check. The resume path passes the ORIGINAL run's id
 * (`fm.resume_of`): the original `awaiting_approval` row and the resuming
 * `running` row are BOTH non-terminal on the same (parent, agent_slug), but
 * the original is the lineage being resumed, not a competing peer, so it must
 * not trip the idempotency violation. A genuine third peer still trips it.
 */
async function preflight(ctx: RunContext, excludeRunId?: string): Promise<boolean> {
  const { run, fm, agent, agentFm } = ctx;
  const runId = run.id;

  // 0 — claude-code backend gate. Refuse to spawn a local CLI unless explicitly
  // enabled for this install (spawns `claude` with host SSH/file access; unsafe
  // on shared/hosted deployments). Cheapest check — runs before any DB work.
  if (ctx.fm.provider === 'claude-code' && !env.FOLIO_CLAUDE_CODE_ENABLED) {
    await failRun(
      ctx,
      runErrorReasonSchema.enum.claude_code_disabled,
      'The claude-code backend is disabled. Set FOLIO_CLAUDE_CODE_ENABLED=true to enable it.',
    );
    return true;
  }

  // 1 — provider key present. FIX #10 — loadContext already resolved + decrypted
  // the key into ctx.apiKey (empty string when absent — a missing key is a
  // pre-flight failure, not a load failure). Derive presence from that instead
  // of a second ai_keys query.
  // claude-code is a keyless local backend — it spawns the `claude` CLI, which
  // authenticates itself. Skip the BYOK key requirement for it.
  if (ctx.fm.provider !== 'claude-code' && !ctx.apiKey) {
    await failRun(
      ctx,
      runErrorReasonSchema.enum.no_ai_key,
      'No AI key configured for this provider.',
    );
    return true;
  }

  // 2 — delegation depth: number of runs sharing this chain_id is the
  // lineage length. If it exceeds the agent's max_delegation_depth, block.
  const maxDepth = (agentFm.max_delegation_depth as number | undefined) ?? 2;
  const depthRows = await db.all<{ count: number }>(sql`
    SELECT COUNT(*) AS count FROM documents
     WHERE type = 'agent_run'
       AND json_extract(frontmatter, '$.chain_id') = ${fm.chain_id}
  `);
  const chainDepth = depthRows[0]?.count ?? 0;
  if (chainDepth > maxDepth) {
    await failRun(
      ctx,
      runErrorReasonSchema.enum.depth_exceeded,
      `Delegation chain depth ${chainDepth} exceeds max ${maxDepth}.`,
    );
    return true;
  }

  // 3 — rate limits (per-workspace + per-agent hourly cap).
  const rate = await checkRunRateLimits({
    workspaceId: run.workspaceId,
    agentSlug: fm.agent_slug,
    workspaceMaxRunsPerHour: env.FOLIO_MAX_RUNS_PER_HOUR_PER_WORKSPACE,
    agentMaxRunsPerHour: env.FOLIO_MAX_RUNS_PER_HOUR_PER_AGENT,
  });
  if (!rate.ok) {
    await failRun(ctx, runErrorReasonSchema.enum.rate_limited, rate.detail);
    return true;
  }

  // 4 — chain guards (fanout / duration / total tokens).
  const chain = await checkChainGuards({
    chainId: fm.chain_id,
    maxFanout: env.FOLIO_MAX_CHAIN_FANOUT,
    maxChainDurationMs: env.FOLIO_MAX_CHAIN_DURATION_MS,
    maxChainTokens: env.FOLIO_MAX_CHAIN_TOKENS,
  });
  if (!chain.ok) {
    // checkChainGuards returns fanout_exceeded / chain_duration_exceeded /
    // chain_tokens_exceeded — all typed literal members of RunErrorReason.
    // FIX #10 — pass through without a redundant first parse; transitionRun
    // closed-enum-validates errorReason again before persisting.
    await failRun(ctx, chain.reason, chain.detail);
    return true;
  }

  // 5 — provider health. Skip for claude-code: it is keyless/local with no
  // tracked health state (and `ProviderName` excludes it).
  if (ctx.fm.provider !== 'claude-code') {
    const health = await checkProviderHealth({
      workspaceId: run.workspaceId,
      provider: fm.provider as ProviderName,
    });
    if (health.next.status === 'degraded') {
      await failRun(
        ctx,
        runErrorReasonSchema.enum.provider_error,
        `Provider degraded after ${health.next.consecutive_failures} consecutive failures.`,
      );
      return true;
    }
  }

  // 6 — idempotency: another sibling run already active on the same parent for
  // this agent slug. getActiveRun returns the most-recent non-terminal run; if
  // it is a DIFFERENT run than this one, a peer is in flight — block.
  //
  // On a resume, `excludeRunId` = the original (`fm.resume_of`) row so the
  // lineage row is dropped from the candidate set BEFORE ordering — this is
  // order-independent (no reliance on created_at tiebreaks between the original
  // and the resuming row). A genuine third peer is still returned and blocks.
  const active = await getActiveRun({
    parentId: ctx.parentId,
    agentSlug: fm.agent_slug,
    excludeRunId,
  });
  if (active && active.id !== runId) {
    await failRun(
      ctx,
      runErrorReasonSchema.enum.idempotency_violation,
      'A sibling run for this agent is already active on the parent.',
    );
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Message-history construction (mitigation 25 — literal text only)
// ---------------------------------------------------------------------------

/**
 * Build the initial message history (oldest first):
 *   - parent doc body as a user message,
 *   - the comment thread on the parent (excluding agent_run/internal noise),
 *     mapped to user (human authors) / assistant (this agent's prior output).
 *
 * NO `[[wiki-link]]` auto-expansion (mitigation 25): bodies + comment text
 * are passed through literally.
 */
async function buildInitialMessages(ctx: RunContext): Promise<Message[]> {
  const messages: Message[] = [];

  if (ctx.parent.body && ctx.parent.body.trim().length > 0) {
    messages.push({ role: 'user', content: ctx.parent.body });
  }

  // Comments are stored with `parentId` = the parent doc id. Only 'normal'
  // visibility comments feed the model context; cancel/internal control
  // comments are not conversational turns.
  const comments = await listComments({
    parentId: ctx.parent.id,
    kind: ['comment', 'result'],
  });
  const selfAuthor = `agent:${ctx.agent.id}`;
  for (const c of comments) {
    const cfm = c.frontmatter as Record<string, unknown>;
    if (typeof cfm.deleted_at === 'string' && cfm.deleted_at.length > 0) continue;
    const body = c.body;
    if (!body || body.trim().length === 0) continue;
    const author = typeof cfm.author === 'string' ? cfm.author : '';
    const role = author === selfAuthor ? 'assistant' : 'user';
    messages.push({ role, content: body });
  }

  return messages;
}

/**
 * Build the message history for an APPROVED-PLAN RESUME (oldest first):
 *   1. parent doc body + the normal comment/result thread (same as a fresh
 *      run — `buildInitialMessages`),
 *   2. PLUS the original run's `kind=plan` comment + ALL `kind=approval`
 *      comments on the parent, surfaced as user-message context so the model
 *      knows its plan was reviewed and approved,
 *   3. PLUS any new comments posted since the original run started awaiting
 *      approval (catch-up context the human may have added).
 *
 * Mitigation 25 — literal text only, no `[[wiki-link]]` expansion.
 */
async function buildResumeMessages(ctx: RunContext): Promise<Message[]> {
  // Reuse the fresh-run base (parent body + comment/result thread). That base
  // already includes the FULL comment/result thread on the parent, so any
  // catch-up comments the human added after the original entered
  // awaiting_approval are picked up here — no delta-from-original needed, which
  // is why the original run row is not consulted during message-building.
  const messages = await buildInitialMessages(ctx);

  // plan + approval comments on the parent become approval context. These are
  // separate `kind`s not picked up by buildInitialMessages (which filters to
  // comment/result), so they are additive — no double-counting.
  const approvalCtx = await listComments({
    parentId: ctx.parent.id,
    kind: ['plan', 'approval'],
  });
  // listComments orders newest-first; reverse so plan (older) precedes
  // approval (newer) in the conversation.
  for (const c of [...approvalCtx].reverse()) {
    const cfm = c.frontmatter as Record<string, unknown>;
    if (typeof cfm.deleted_at === 'string' && cfm.deleted_at.length > 0) continue;
    if (!c.body || c.body.trim().length === 0) continue;
    messages.push({ role: 'user', content: c.body });
  }

  return messages;
}

/** Translate the agent's tool whitelist into provider-side ToolDefs. */
function buildToolDefs(agentFm: Record<string, unknown>): ToolDef[] {
  const tools = Array.isArray(agentFm.tools) ? (agentFm.tools as string[]) : [];
  // Provider-side ToolDef carries the JSON-schema input contract. C-8 ships
  // the runner skeleton; the real per-tool input schemas are wired with the
  // tool handlers in D-3. Until then, advertise an open object schema so the
  // provider accepts the tool name and the dispatcher (executeTool) does the
  // authoritative Zod validation on the args.
  return tools.map((name) => ({
    name,
    description: name,
    input_schema: { type: 'object', additionalProperties: true },
  }));
}

// ---------------------------------------------------------------------------
// The outer round-loop
// ---------------------------------------------------------------------------

async function runLoop(ctx: RunContext, messages: Message[]): Promise<void> {
  const { run, fm } = ctx;
  const runId = run.id;
  const providerLabel = PROVIDER_LABELS[fm.provider as ProviderName] ?? 'Claude Code';

  const tools = buildToolDefs(ctx.agentFm);

  let round = 0;
  // Mitigation 64 — consecutive all-error rounds (no successful tool result).
  // Reset to 0 whenever a round makes progress; failRun(tool_error) when it
  // reaches MAX_CONSECUTIVE_TOOL_ERRORS.
  let consecutiveToolErrorRounds = 0;
  while (round < MAX_TOOL_ROUNDS) {
    round++;

    const collectedToolCalls: Array<{ id: string; name: string; arguments: unknown }> = [];
    let textBuf = '';
    let doneReason: RunDoneReason | undefined;
    let terminated = false; // a budget/cancel/tool-error path already failed the run

    const provider = getProvider(fm.provider);
    const stream = provider.stream({
      system: ctx.fm.system_prompt,
      messages,
      tools,
      maxTokens: fm.max_tokens,
      apiKey: ctx.apiKey,
      model: fm.model,
      baseUrl: ctx.baseUrl,
    });

    for await (const ev of stream) {
      if (ev.type === 'text') {
        textBuf += ev.delta;
      } else if (ev.type === 'tokens') {
        // FIX #10 — incrementTokens returns the post-increment totals atomically;
        // use them directly instead of a redundant read-back SELECT.
        const { tokens_in: usedIn, tokens_out: usedOut } = await incrementTokens(runId, {
          in: ev.tokens_in,
          out: ev.tokens_out,
        });
        if (usedIn + usedOut > fm.max_tokens) {
          await postAgentComment(
            ctx,
            `Budget cap exceeded after ${usedIn + usedOut} tokens — partial work above.`,
            'comment',
          );
          await failRun(
            ctx,
            runErrorReasonSchema.enum.budget_exceeded,
            `Token budget ${fm.max_tokens} exceeded (${usedIn + usedOut} used).`,
          );
          terminated = true;
          break;
        }
      } else if (ev.type === 'tool_call') {
        // Cancel-via-comment check (mitigation 44) BEFORE executing the tool.
        if (await wasCancelled(ctx)) {
          await handleCancel(ctx);
          terminated = true;
          break;
        }
        collectedToolCalls.push({ id: ev.id, name: ev.name, arguments: ev.arguments });
      } else if (ev.type === 'done') {
        doneReason = ev.reason;
      }
    }

    if (terminated) return;

    // Tool round — execute collected calls, append the round-trip messages,
    // loop again.
    if (doneReason === 'tool_use' && collectedToolCalls.length > 0) {
      // D-9.2 — RECOVERABLE tool errors are FED BACK to the model instead of
      // terminating the run (mitigations 64-66). We accumulate the assistant
      // tool_calls message + per-call tool-result messages in LOCALS:
      //   - success            → result string (roundHadSuccess = true)
      //   - recoverable error  → sanitized error message (roundHadRecoverableError)
      //   - FATAL error        → abort the WHOLE round: failRun + return, no
      //                          half-round committed, no feed-back (decision 5).
      // After the loop (no fatal), commit assistantMsg + ALL tool-result
      // messages atomically, then apply the consecutive-error counter, then
      // continue. A prior call in this batch may have already committed its own
      // tx (mitigation 35 — acceptable; each tool gets its own tx).
      const assistantMsg: Message = {
        role: 'assistant',
        content: textBuf,
        tool_calls: collectedToolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        })),
      };
      const toolResultMsgs: Message[] = [];
      let roundHadSuccess = false;
      let roundHadRecoverableError = false;
      let fatalReturned = false;

      for (const tc of collectedToolCalls) {
        try {
          // tx=undefined — each tool gets its own short-lived tx (mitigation 35).
          const result = await executeTool(ctx.token, ctx.actor, tc.name, tc.arguments);
          const resultString = typeof result === 'string' ? result : JSON.stringify(result);
          toolResultMsgs.push({ role: 'tool', tool_use_id: tc.id, content: resultString });
          roundHadSuccess = true;
        } catch (err) {
          if (isFatalToolError(err)) {
            // FATAL — scope-denied / unknown tool. Abort the whole round
            // immediately; do NOT commit a half-round or feed back (decision 5,
            // mitigation 66). One fatal call terminates the run even if siblings
            // were recoverable.
            await failRun(
              ctx,
              runErrorReasonSchema.enum.provider_error,
              sanitizeProviderError(err, providerLabel),
            );
            fatalReturned = true;
            break;
          }
          if (isInvalidArgs(err)) {
            // RECOVERABLE — bad args. Feed back the invalid PATHS only, never
            // values (mitigation 65). err.issues are already paths-only from
            // C-7: map each i.path to a dotted string; never JSON.stringify
            // anything that could carry a value.
            const paths = err.issues
              .map((i) => (Array.isArray(i.path) ? i.path.join('.') : String(i.path)))
              .join(', ');
            toolResultMsgs.push({
              role: 'tool',
              tool_use_id: tc.id,
              content: `Tool '${tc.name}' rejected the arguments. Invalid fields: ${paths}. Fix and retry.`,
            });
            roundHadRecoverableError = true;
            continue;
          }
          // RECOVERABLE — handler-execution throw (DOCUMENT_NOT_FOUND,
          // SLUG_CONFLICT, a tool's own thrown error, …). Feed back the SAFE
          // machine code/reason (HTTPError.code or mcpInvalidParams reason) so
          // the model can self-correct, falling back to the status-sanitized
          // phrase for unknown throws (mitigation 65 — never a raw SDK string /
          // key / baseUrl / arg value / message body).
          toolResultMsgs.push({
            role: 'tool',
            tool_use_id: tc.id,
            content: `Tool '${tc.name}' failed: ${safeToolErrorMessage(err, providerLabel)}. Adjust and retry.`,
          });
          roundHadRecoverableError = true;
        }
      }

      if (fatalReturned) return;

      // Commit the balanced round-trip atomically (success + recoverable-error
      // results together).
      messages.push(assistantMsg, ...toolResultMsgs);

      // Consecutive-error counter (mitigation 64). A round with ≥1 success is
      // progress → reset. A round that was ALL recoverable errors (zero
      // successes) → increment; at the sub-cap, fail with `tool_error`.
      if (roundHadSuccess) {
        consecutiveToolErrorRounds = 0;
      } else if (roundHadRecoverableError) {
        consecutiveToolErrorRounds++;
        if (consecutiveToolErrorRounds >= MAX_CONSECUTIVE_TOOL_ERRORS) {
          await failRun(
            ctx,
            runErrorReasonSchema.enum.tool_error,
            `Model failed to recover after ${MAX_CONSECUTIVE_TOOL_ERRORS} consecutive tool errors.`,
          );
          return;
        }
      }

      continue; // next round
    }

    // FIX #3 — done_reason='tool_use' with ZERO usable tool_calls. The model
    // signalled it wants a tool but produced no call the provider could surface
    // (e.g. a malformed tool_call the provider dropped). Completing cleanly
    // would mask a failed generation as success. Fail loudly; no result comment.
    if (doneReason === 'tool_use' && collectedToolCalls.length === 0) {
      await failRun(
        ctx,
        runErrorReasonSchema.enum.provider_error,
        'Provider signalled tool_use but produced no usable tool call.',
      );
      return;
    }

    // FIX #2 — the stream ended without ever yielding a `done` event (doneReason
    // still undefined and not terminated). Treat a stream that stops without a
    // completion signal as a truncated/failed generation, NOT a clean complete
    // with partial text. Fail loudly; no result comment.
    if (doneReason === undefined) {
      await failRun(
        ctx,
        runErrorReasonSchema.enum.provider_error,
        'Provider stream ended without a completion signal.',
      );
      return;
    }

    // Terminal (stop / max_tokens / refusal / pause_turn, or no tool_calls).
    // refusal + pause_turn are CLEAN completions (mitigation 20) → completed.
    //
    // Pure-text runs (text + done, no tool_call) never hit the tool_call
    // cancel check above, so a user's "stop" would be silently ignored. Check
    // wasCancelled once on the terminal path (mitigation 44): one extra
    // comment-thread read on the final round, which is acceptable.
    //
    // FIX #5 — this terminal check intentionally applies to BOTH fresh and
    // resume runs (runLoop is shared). A post-start rejection landing during a
    // resume is a deliberate mid-resume stop, so it cancels an otherwise-
    // completing approved resume. Intended, not a bug — pinned by a test.
    if (await wasCancelled(ctx)) {
      await handleCancel(ctx);
      return;
    }

    await postResultAndComplete(ctx, textBuf, doneReason);
    return;
  }

  // Round cap exhausted — runaway tool loop. chain_guard family: use
  // fanout_exceeded (closest enum member for "too many rounds").
  await failRun(
    ctx,
    runErrorReasonSchema.enum.fanout_exceeded,
    `Exceeded ${MAX_TOOL_ROUNDS} tool rounds without terminating.`,
  );
}

// ---------------------------------------------------------------------------
// Terminal handling
// ---------------------------------------------------------------------------

/**
 * claude-code execution branch. CC runs its own agentic loop to completion;
 * we capture the transcript onto the run body, post the final result as a
 * kind=result comment, and transition the run. Pre-run approval
 * (requires_approval) is handled by the existing awaiting_approval gate before
 * this point. v1 passes no MCP token (mcpToken: '') — the fresh-token mint is
 * a fast-follow (Task 7b).
 *
 * KNOWN GAP (deferred): no mid-run cancellation. CC runs its own loop to
 * completion; a rejection comment posted DURING a CC run is not observed (unlike
 * the API path's per-tool-boundary wasCancelled check). Subprocess cancel lands
 * with the Task 7b token/lifecycle work.
 */
async function ccExecute(ctx: RunContext): Promise<void> {
  // Mint a short-lived scoped bearer token so CC can call back into Folio's MCP
  // endpoint. The token mirrors the run's existing agent token (same scopes,
  // agentId, projectIds) and is revoked unconditionally in the finally block.
  const { token: ccToken, hash: ccHash } = newApiToken();
  const ccTokenId = nanoid();
  await db.insert(apiTokens).values({
    id: ccTokenId,
    workspaceId: ctx.token.workspaceId,
    name: `cc-run:${ctx.run.id}`,
    tokenHash: ccHash,
    scopes: ctx.token.scopes,
    agentId: ctx.token.agentId,
    projectIds: ctx.token.projectIds,
    createdBy: ctx.transitionActor,
  });

  try {
    const outcome = await runClaudeCode(
      {
        systemPrompt: ctx.fm.system_prompt,
        model: ctx.fm.model && ctx.fm.model.length > 0 ? ctx.fm.model : undefined,
        mcpToken: ccToken,
        mcpUrl: `${env.PUBLIC_URL}/mcp`,
        // v1: Folio's own cwd (spec decision). CC's host context comes from the
        // prompt, not the cwd. Per-agent working_dir is a named deferral.
        cwd: process.cwd(),
      },
      __ccSpawnOverride ? { spawn: __ccSpawnOverride } : {},
    );

    // Always persist the transcript (even on failure) for audit.
    await setRunBody(ctx.run.id, outcome.transcript);

    if (outcome.status === 'failed') {
      // non-zero CC exit = provider-level failure (claude_code_disabled covers
      // the gate case; this is a runtime CC failure).
      await failRun(ctx, runErrorReasonSchema.enum.provider_error, outcome.detail);
      return;
    }

    await postAgentComment(ctx, outcome.result, 'result');
    await transitionRun(ctx.run.id, { newStatus: 'completed', actor: ctx.transitionActor });
  } finally {
    // Revoke the ephemeral MCP token regardless of success or failure.
    await db.delete(apiTokens).where(eq(apiTokens.id, ccTokenId));
  }
}

/**
 * Write the accumulated text as the final `kind=result` comment, then
 * transition the run to completed — persisting `done_reason` ATOMICALLY in the
 * same transition (FIX #4). transitionRun folds done_reason into its existing
 * status `json_set` and emits `agent.run.completed`, so the done_reason write,
 * the status flip, and the event all commit together. No more bare out-of-tx
 * json_set that could strand done_reason on a still-running row (or hide it
 * from SSE subscribers, who now see it on the completed event).
 */
async function postResultAndComplete(
  ctx: RunContext,
  textBuf: string,
  doneReason: RunDoneReason | undefined,
): Promise<void> {
  const runId = ctx.run.id;

  // Final answer as a kind=result comment on the parent, linking the run.
  const finalText = textBuf.trim().length > 0 ? textBuf : '(no output)';
  await postAgentComment(ctx, finalText, 'result');

  // transitionRun owns its own txWithEvents; done_reason rides inside it.
  await transitionRun(runId, {
    newStatus: 'completed',
    actor: ctx.transitionActor,
    doneReason,
  });
}

// ---------------------------------------------------------------------------
// Helpers — comments, cancel detection, transitions
// ---------------------------------------------------------------------------

/**
 * Post an agent-authored comment on the parent. `kind=result` for the final
 * answer; `kind=comment` for partial / cancel / budget messages.
 *
 * Note on run linkage: this path deliberately omits `run_id`. The runner only
 * authors `result` / `comment` kind comments, and run linkage on those isn't
 * needed — the run is its own source of truth for its outcome. (`createComment`
 * does accept a `run_id` input as of E-4b; that capability exists for the
 * plan-comment path posted via the API, not this one.)
 */
async function postAgentComment(
  ctx: RunContext,
  body: string,
  kind: 'result' | 'comment',
): Promise<void> {
  await createComment({
    workspace: ctx.workspace,
    project: ctx.project,
    parent: ctx.parent,
    authorContext: ctx.authorContext,
    actor: ctx.actor,
    body,
    kind,
  });
}

/**
 * Detect a cancel signal created AFTER the run started (mitigation 44).
 *
 * The plan named a `kind=cancel` comment, but the comment schema has no
 * `cancel` kind (see comment-schema.ts) — DIVERGENCE. A user cancels an
 * in-flight run by posting a `kind=rejection` comment (the user-facing
 * "stop this" signal in the existing approval/rejection flow). We treat a
 * post-start rejection on the parent as the cancel trigger.
 */
async function wasCancelled(ctx: RunContext): Promise<boolean> {
  // FIX #1 — INCLUSIVE boundary (createdAt >= started_at). listComments' `since`
  // filter is strict `>` (gt), which drops a rejection stamped in the SAME
  // millisecond as started_at — a real mid-run cancel that races the run's own
  // start timestamp. A rejection BEFORE started_at belongs to a prior run/plan
  // (handled by rejectRun's awaiting_approval→rejected path); a rejection
  // AT-OR-AFTER start is a valid mid-run cancel. So we fetch all rejections on
  // the parent and apply the inclusive comparison ourselves rather than relying
  // on listComments' exclusive `since`.
  const rejections = await listComments({
    parentId: ctx.parent.id,
    kind: 'rejection',
  });
  const startedMs = new Date(ctx.fm.started_at).getTime();
  return rejections.some((c) => new Date(c.createdAt).getTime() >= startedMs);
}

/**
 * Shared cancel handling (mitigation 44), called from both the tool_call branch
 * and the terminal path: post the partial-work cancel comment from the agent,
 * then transition the run to failed/cancelled. Does NOT write a kind=result
 * comment — the partial work already streamed into the cancel comment above.
 */
async function handleCancel(ctx: RunContext): Promise<void> {
  await postAgentComment(ctx, 'Cancelled by user — partial work above.', 'comment');
  await failRun(ctx, runErrorReasonSchema.enum.cancelled, 'Cancelled by user via comment.');
}

function isInvalidArgs(
  err: unknown,
): err is Error & { issues: Array<{ path: Array<string | number> }> } {
  return err instanceof Error && err.message === 'MCP_INVALID_ARGS' && 'issues' in err;
}

/**
 * D-9.2 — actionable, leak-free message for a RECOVERABLE handler throw fed back
 * to the model (mitigation 65). The real registry tools throw shapes that carry
 * a SAFE machine code that's far more actionable than a status-only sanitize:
 *
 *   - `HTTPError(code, message, status)` — `.code` is a developer-authored,
 *     closed enum string (e.g. `PARENT_NOT_FOUND`, `SLUG_CONFLICT`,
 *     `RUN_ALREADY_ACTIVE`). Surface the `.code`, NEVER `.message` (it
 *     interpolates slugs/titles/values — verified at the throw sites in
 *     agent-tools-registry.ts / services/documents.ts).
 *   - `mcpInvalidParams(message, {reason})` — `.data.reason` is a
 *     developer-authored, closed string (e.g. `parent_not_found`,
 *     `agent_missing`). Surface the `reason`, NEVER `.message` (same leak risk),
 *     and NEVER the numeric `.code` (-32602 is uninformative).
 *
 * Security invariant (mitigation 65): the returned string is ONLY a code/reason
 * (machine enum) or a status-sanitized phrase — never `err.message`, never arg
 * values, never an SDK body. The `.code`/`.reason` strings are closed
 * developer constants (not user/tool input), so they are safe to surface.
 *
 * Unknown throws (a bare `Error`, no string `.code`, no `.data.reason`) fall
 * back to `sanitizeProviderError` — the status-based whitelist, still safe.
 */
function safeToolErrorMessage(err: unknown, providerLabel: string): string {
  if (err != null && typeof err === 'object') {
    // HTTPError: string `.code` enum (e.g. PARENT_NOT_FOUND). Guard on string
    // so the numeric mcpInvalidParams `.code` (-32602) does not match here.
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) {
      return code;
    }
    // mcpInvalidParams shape: `.data.reason` (string).
    const reason = (err as { data?: { reason?: unknown } }).data?.reason;
    if (typeof reason === 'string' && reason.length > 0) {
      return reason;
    }
  }
  return sanitizeProviderError(err, providerLabel);
}

/**
 * D-9.2 — a FATAL tool error terminates the run (no feed-back). Two classes:
 *   - scope-denied: executeTool throws `forbidden: scope <s> missing` when the
 *     agent's token lacks the tool's required scope (mitigation 66).
 *   - unknown tool: executeTool throws `method not found: <name>` for a tool
 *     not in the registry (or the test-only `__echo` outside NODE_ENV=test).
 * Everything else (handler throws, MCP_INVALID_ARGS) is recoverable.
 */
function isFatalToolError(err: unknown): err is Error {
  return (
    err instanceof Error &&
    (err.message.startsWith('forbidden: scope') || err.message.startsWith('method not found'))
  );
}

/**
 * Shared predicate for "the run already left the source status under us".
 * `transitionRun` throws RUN_TRANSITION_RACED (TOCTOU loser — UPDATE WHERE
 * status=from affected 0 rows) or INVALID_RUN_TRANSITION (illegal move). Both
 * mean a concurrent path already moved the run terminal; the caller treats it
 * as a benign no-op.
 */
function isAlreadyTerminalRace(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code;
  return code === 'RUN_TRANSITION_RACED' || code === 'INVALID_RUN_TRANSITION';
}

/** Transition the run to failed with a closed-enum reason + sanitized detail. */
async function failRun(
  ctx: RunContext,
  errorReason: NonNullable<AgentRunFrontmatter['error_reason']>,
  errorDetail: string,
): Promise<void> {
  // transitionRun owns its own `txWithEvents` (UPDATE + event emit commit
  // atomically). Call it directly — no outer wrapper (which would nest an
  // empty db.transaction whose fn never emits).
  await transitionRun(ctx.run.id, {
    newStatus: 'failed',
    actor: ctx.transitionActor,
    errorReason,
    errorDetail,
  });
}

/**
 * Last-resort failure from the top-level catch. If the transition itself
 * races (run already terminal), swallow + return. Any other failure → log.
 * Resolves an FK-valid actor from the run row directly (context may not be
 * loaded when the throw happened).
 */
async function failRunLastResort(
  runId: string,
  providerLabel: string,
  err: unknown,
): Promise<void> {
  const runRow = await db.query.documents.findFirst({
    where: and(eq(documents.id, runId), eq(documents.type, 'agent_run')),
  });
  // FIX #9 — no empty-string actor fallback. `documents.updated_by` has a FK to
  // `users.id`; an empty string violates it and would strand the run at running.
  // If the run row's createdBy is absent (unexpected in C.2, where createRun
  // always stamps an FK-valid owner — a C.3 obligation when other create paths
  // land), log and leave the run for orphan-recovery rather than attempt an
  // FK-violating transition.
  const actor = runRow?.createdBy;
  if (!actor) {
    console.error(
      `[runner] last-resort failure for run ${runId}: no FK-valid actor (createdBy absent); leaving for orphan-recovery`,
    );
    return;
  }
  try {
    await transitionRun(runId, {
      newStatus: 'failed',
      actor,
      errorReason: runErrorReasonSchema.enum.provider_error,
      errorDetail: sanitizeProviderError(err, providerLabel),
    });
  } catch (transitionErr) {
    if (isAlreadyTerminalRace(transitionErr)) {
      // Run is already terminal — nothing more to do.
      return;
    }
    console.error(`[runner] last-resort failure transition for run ${runId} threw:`, transitionErr);
  }
}

// ---------------------------------------------------------------------------
// rejectRun — awaiting_approval → rejected (SYNCHRONOUS, not a poller path)
// ---------------------------------------------------------------------------

/**
 * Reject a pending-approval run, invoked SYNCHRONOUSLY by the C.3
 * trigger-matcher when a `kind=rejection` comment lands on a parent that has an
 * `awaiting_approval` run. This is NOT a mid-stream cancel (that path is C-8's
 * `wasCancelled`, mitigation 44) — it's the distinct awaiting_approval → rejected
 * lifecycle edge.
 *
 * Flow:
 *   1. Load the run + its parent/workspace/project (for the closing comment).
 *   2. Transition `awaiting_approval → rejected` via `transitionRun`, using the
 *      run's `created_by` as a FK-valid actor (reconciliation 3 — a free-form
 *      `system:*` actor violates `documents.updated_by`'s FK to `users.id`).
 *   3. Mitigation 43 (approval/rejection race) — first-COMMIT-wins. If the
 *      approval handler already moved the run out of awaiting_approval, our
 *      WHERE `status='awaiting_approval'` matches zero rows → transitionRun
 *      throws `RUN_TRANSITION_RACED`; or, if the row is already at a status
 *      from which rejected is not a legal move, the state-machine guard throws
 *      `INVALID_RUN_TRANSITION`. BOTH mean "the run already left
 *      awaiting_approval" — we return silently, emitting nothing.
 *   4. Any other error (e.g. AGENT_RUN_NOT_FOUND) re-throws to the caller.
 *   5. On a successful rejection, post a closing `kind=comment` from the agent
 *      AFTER the terminal transition (so SSE subscribers see the status flip
 *      first). The rejection-comment id is referenced in the BODY text, not in
 *      frontmatter (reconciliation 4 — createComment carries no passthrough fm).
 *
 * `agent.run.rejected` is emitted by transitionRun's standard event emission.
 *
 * Mitigation 42 (graceful-shutdown SIGTERM) is a DOCUMENTED v1.1 residual —
 * no SIGTERM handler is added here.
 */
export async function rejectRun(args: {
  runId: string;
  rejectionCommentId: string;
}): Promise<void> {
  const { runId, rejectionCommentId } = args;

  const run = await db.query.documents.findFirst({
    where: and(eq(documents.id, runId), eq(documents.type, 'agent_run')),
  });
  if (!run) {
    // Non-race error — re-throw (mirrors transitionRun's AGENT_RUN_NOT_FOUND).
    throw new HTTPError('AGENT_RUN_NOT_FOUND', `agent_run ${runId} not found`, 404);
  }
  // FK-valid actor for the transition's updated_by write (reconciliation 3).
  // FIX #9 — no empty-string fallback (`documents.updated_by` FK→users.id). In
  // C.2 createRun always stamps an FK-valid owner; if absent (unexpected — a
  // C.3 obligation when other create paths land) the rejection cannot write a
  // valid updated_by, so leave the run as-is rather than violate the FK.
  const transitionActor = run.createdBy;
  if (!transitionActor) {
    console.error(
      `[runner] rejectRun for run ${runId}: no FK-valid actor (createdBy absent); skipping`,
    );
    return;
  }

  try {
    // transitionRun owns its own txWithEvents (atomic UPDATE + event emit).
    await transitionRun(runId, { newStatus: 'rejected', actor: transitionActor });
  } catch (err) {
    // Mitigation 43 — the approval handler won the race (RUN_TRANSITION_RACED),
    // or the run already left awaiting_approval by another path
    // (INVALID_RUN_TRANSITION). Either way the rejection is a no-op.
    if (isAlreadyTerminalRace(err)) {
      return;
    }
    throw err;
  }

  // Post the closing comment AFTER the terminal transition. Load the
  // parent/workspace/project for createComment. If any is missing the run is
  // already rejected (durable truth); the comment is best-effort.
  if (!run.parentId || !run.projectId) return;
  const parent = await db.query.documents.findFirst({ where: eq(documents.id, run.parentId) });
  const workspace = await db.query.workspaces.findFirst({
    where: eq(workspaces.id, run.workspaceId),
  });
  const project = await db.query.projects.findFirst({
    where: eq(projectsTable.id, run.projectId),
  });
  const fm = run.frontmatter as AgentRunFrontmatter;
  const agent = await db.query.documents.findFirst({
    where: and(
      eq(documents.workspaceId, run.workspaceId),
      eq(documents.type, 'agent'),
      eq(documents.slug, fm.agent_slug),
    ),
  });
  if (!parent || !workspace || !project || !agent) return;

  await createComment({
    workspace,
    project,
    parent,
    authorContext: { type: 'agent', agentSlug: agent.slug, agentId: agent.id },
    actor: `agent:${agent.slug}`,
    body: `Run cancelled by reviewer. (rejection: ${rejectionCommentId})`,
    kind: 'comment',
  });
}
