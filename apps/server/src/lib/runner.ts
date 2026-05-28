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
import { db } from '../db/client.ts';
import {
  aiKeys,
  apiTokens,
  documents,
  projects as projectsTable,
  workspaces,
  type ApiToken,
  type Document,
  type Project,
  type Workspace,
} from '../db/schema.ts';
import {
  transitionRun,
  incrementTokens,
  getActiveRun,
  checkRunRateLimits,
  checkChainGuards,
  checkProviderHealth,
  type ProviderName,
} from '../services/agent-runs.ts';
import { createComment, listComments, type AuthorContext } from '../services/comments.ts';
import {
  runErrorReasonSchema,
  type AgentRunFrontmatter,
  type RunDoneReason,
} from './agent-run-schema.ts';
import { getProvider, type Message, type ToolDef } from './ai/provider.ts';
import { sanitizeProviderError } from './ai/sanitize-error.ts';
import { decryptSecret } from './crypto.ts';
import { executeTool } from './agent-tools.ts';

/**
 * Hard cap on outer provider rounds (one provider call + one tool-result
 * feedback = one round). This is the CHAIN-GUARD for a single run's tool
 * loop, NOT `max_delegation_depth` (cross-run fanout). A run that asks for a
 * tool 25 times without ever terminating is treated as a runaway loop and
 * failed with `chain_guard`.
 */
const MAX_TOOL_ROUNDS = 25;

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

// ---------------------------------------------------------------------------
// Loaded context
// ---------------------------------------------------------------------------

interface RunContext {
  run: Document;
  fm: AgentRunFrontmatter;
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
    providerLabel = PROVIDER_LABELS[ctx.fm.provider];

    // --- pre-flight checks (cheapest first); each returns true if it BLOCKED.
    if (await preflight(ctx)) return;

    // --- stream consumption (outer round-loop).
    await runLoop(ctx);
  } catch (err) {
    // Top-level containment. Any unhandled throw → fail the run with a
    // sanitized detail. If the last-resort transition itself races (run
    // already terminal), swallow + return. Never propagate to the poller.
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
  const parent = await db.query.documents.findFirst({
    where: eq(documents.id, run.parentId),
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
  const transitionActor = run.createdBy ?? agent.createdBy ?? '';
  const authorContext: AuthorContext = {
    type: 'agent',
    agentSlug: agent.slug,
    agentId: agent.id,
  };

  // BYOK key for the run's snapshotted provider. Absent key is a pre-flight
  // failure (no_ai_key), not a load failure — but resolve it here so the
  // pre-flight check is a pure read. Carry undefined through when missing.
  const keyRow = await db.query.aiKeys.findFirst({
    where: and(eq(aiKeys.workspaceId, run.workspaceId), eq(aiKeys.provider, fm.provider)),
  });
  const apiKey = keyRow ? decryptSecret(keyRow.encryptedKey) : '';
  const baseUrl = keyRow?.baseUrl ?? undefined;

  return {
    run,
    fm,
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
 */
async function preflight(ctx: RunContext): Promise<boolean> {
  const { run, fm, agent, agentFm } = ctx;
  const runId = run.id;

  // 1 — provider key present.
  const hasKey = await db.query.aiKeys.findFirst({
    where: and(eq(aiKeys.workspaceId, run.workspaceId), eq(aiKeys.provider, fm.provider)),
  });
  if (!hasKey) {
    await failRun(ctx, runErrorReasonSchema.enum.no_ai_key, 'No AI key configured for this provider.');
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
    await failRun(ctx,
      runErrorReasonSchema.enum.depth_exceeded,
      `Delegation chain depth ${chainDepth} exceeds max ${maxDepth}.`,
    );
    return true;
  }

  // 3 — rate limits (per-workspace + per-agent hourly cap).
  const rate = await checkRunRateLimits({
    workspaceId: run.workspaceId,
    agentSlug: fm.agent_slug,
    workspaceMaxRunsPerHour: Number(process.env.FOLIO_MAX_RUNS_PER_HOUR_PER_WORKSPACE ?? 100),
    agentMaxRunsPerHour: Number(process.env.FOLIO_MAX_RUNS_PER_HOUR_PER_AGENT ?? 50),
  });
  if (!rate.ok) {
    await failRun(ctx, runErrorReasonSchema.enum.rate_limited, rate.detail);
    return true;
  }

  // 4 — chain guards (fanout / duration / total tokens).
  const chain = await checkChainGuards({
    chainId: fm.chain_id,
    maxFanout: Number(process.env.FOLIO_MAX_CHAIN_FANOUT ?? 25),
    maxChainDurationMs: Number(process.env.FOLIO_MAX_CHAIN_DURATION_MS ?? 30 * 60_000),
    maxChainTokens: Number(process.env.FOLIO_MAX_CHAIN_TOKENS ?? 200_000),
  });
  if (!chain.ok) {
    // checkChainGuards returns fanout_exceeded / chain_duration_exceeded /
    // chain_tokens_exceeded — all real enum members. Pass through verbatim.
    const reason = runErrorReasonSchema.parse(chain.reason);
    await failRun(ctx, reason, chain.detail);
    return true;
  }

  // 5 — provider health.
  const health = await checkProviderHealth({
    workspaceId: run.workspaceId,
    provider: fm.provider,
  });
  if (health.next.status === 'degraded') {
    await failRun(ctx,
      runErrorReasonSchema.enum.provider_error,
      `Provider degraded after ${health.next.consecutive_failures} consecutive failures.`,
    );
    return true;
  }

  // 6 — idempotency: another sibling run already active on the same parent for
  // this agent slug. getActiveRun returns the most-recent non-terminal run; if
  // it is a DIFFERENT run than this one, a peer is in flight — block.
  const active = await getActiveRun({ parentId: run.parentId!, agentSlug: fm.agent_slug });
  if (active && active.id !== runId) {
    await failRun(ctx,
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

async function runLoop(ctx: RunContext): Promise<void> {
  const { run, fm } = ctx;
  const runId = run.id;
  const providerLabel = PROVIDER_LABELS[fm.provider];

  const messages = await buildInitialMessages(ctx);
  const tools = buildToolDefs(ctx.agentFm);

  let round = 0;
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
        await incrementTokens(runId, { in: ev.tokens_in, out: ev.tokens_out });
        // Re-read the live totals to compare against the run's budget. The
        // increment is atomic; we read back the fresh row.
        const fresh = await db.query.documents.findFirst({
          where: and(eq(documents.id, runId), eq(documents.type, 'agent_run')),
        });
        const ffm = (fresh?.frontmatter ?? {}) as Record<string, unknown>;
        const usedIn = typeof ffm.tokens_in === 'number' ? ffm.tokens_in : 0;
        const usedOut = typeof ffm.tokens_out === 'number' ? ffm.tokens_out : 0;
        if (usedIn + usedOut > fm.max_tokens) {
          await postAgentComment(
            ctx,
            `Budget cap exceeded after ${usedIn + usedOut} tokens — partial work above.`,
            'comment',
          );
          await failRun(ctx,
            runErrorReasonSchema.enum.budget_exceeded,
            `Token budget ${fm.max_tokens} exceeded (${usedIn + usedOut} used).`,
          );
          terminated = true;
          break;
        }
      } else if (ev.type === 'tool_call') {
        // Cancel-via-comment check (mitigation 44) BEFORE executing the tool.
        if (await wasCancelled(ctx)) {
          await postAgentComment(ctx, 'Cancelled by user — partial work above.', 'comment');
          await failRun(ctx, runErrorReasonSchema.enum.cancelled, 'Cancelled by user via comment.');
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
      messages.push({
        role: 'assistant',
        content: textBuf,
        tool_calls: collectedToolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        })),
      });

      for (const tc of collectedToolCalls) {
        let resultString: string;
        try {
          // tx=undefined — each tool gets its own short-lived tx (mitigation 35).
          const result = await executeTool(ctx.token, ctx.actor, tc.name, tc.arguments);
          resultString = typeof result === 'string' ? result : JSON.stringify(result);
        } catch (err) {
          if (isInvalidArgs(err)) {
            // error_detail = the issue PATHS only (no values — already
            // paths-only from C-7). JSON.stringify the issues array.
            await failRun(ctx,
              runErrorReasonSchema.enum.provider_error,
              JSON.stringify(err.issues),
            );
            return;
          }
          // Any other tool throw → sanitized detail.
          await failRun(ctx,
            runErrorReasonSchema.enum.provider_error,
            sanitizeProviderError(err, providerLabel),
          );
          return;
        }
        messages.push({ role: 'tool', tool_use_id: tc.id, content: resultString });
      }

      continue; // next round
    }

    // Terminal (stop / max_tokens / refusal / pause_turn, or no tool_calls).
    // refusal + pause_turn are CLEAN completions (mitigation 20) → completed.
    await postResultAndComplete(ctx, textBuf, doneReason);
    return;
  }

  // Round cap exhausted — runaway tool loop. chain_guard family: use
  // fanout_exceeded (closest enum member for "too many rounds").
  await failRun(ctx,
    runErrorReasonSchema.enum.fanout_exceeded,
    `Exceeded ${MAX_TOOL_ROUNDS} tool rounds without terminating.`,
  );
}

// ---------------------------------------------------------------------------
// Terminal handling
// ---------------------------------------------------------------------------

/**
 * Write the accumulated text as the final `kind=result` comment, persist
 * `done_reason`, then transition the run to completed.
 */
async function postResultAndComplete(
  ctx: RunContext,
  textBuf: string,
  doneReason: RunDoneReason | undefined,
): Promise<void> {
  const runId = ctx.run.id;

  // Persist done_reason into frontmatter (independent of the transition's
  // status/error columns). transitionRun's json_set preserves untouched keys,
  // so write done_reason first.
  if (doneReason) {
    await db
      .update(documents)
      .set({
        frontmatter: sql`json_set(${documents.frontmatter}, '$.done_reason', ${doneReason})`,
      })
      .where(and(eq(documents.id, runId), eq(documents.type, 'agent_run')));
  }

  // Final answer as a kind=result comment on the parent, linking the run.
  const finalText = textBuf.trim().length > 0 ? textBuf : '(no output)';
  await postAgentComment(ctx, finalText, 'result');

  await txWithEventsTransition(runId, ctx.transitionActor, 'completed', undefined, undefined);
}

// ---------------------------------------------------------------------------
// Helpers — comments, cancel detection, transitions
// ---------------------------------------------------------------------------

/**
 * Post an agent-authored comment on the parent. `kind=result` for the final
 * answer; `kind=comment` for partial / cancel / budget messages.
 *
 * Note on run linkage: `createComment` does not accept a `run_id` input, so the
 * comment→run linkage is not stamped on the comment row here. The run remains
 * the source of truth for its own outcome; the comment is the human-facing
 * surface. (Wiring run_id into comment frontmatter would require a
 * createComment signature change, deferred to C-9/D.)
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
  const cancels = await listComments({
    parentId: ctx.parent.id,
    kind: 'rejection',
    since: ctx.fm.started_at,
  });
  return cancels.length > 0;
}

function isInvalidArgs(err: unknown): err is Error & { issues: unknown } {
  return (
    err instanceof Error &&
    err.message === 'MCP_INVALID_ARGS' &&
    'issues' in err
  );
}

/**
 * Wrap `transitionRun` in `txWithEvents`. transitionRun reads its own row but
 * its UPDATE + event emit must commit atomically — the caller owns the tx
 * boundary. We import txWithEvents lazily to keep the top imports tidy.
 */
async function txWithEventsTransition(
  runId: string,
  actor: string,
  newStatus: 'completed' | 'failed',
  errorReason: AgentRunFrontmatter['error_reason'] | undefined,
  errorDetail: string | undefined,
): Promise<void> {
  const { txWithEvents } = await import('./events.ts');
  await txWithEvents(db, async () => {
    await transitionRun(runId, {
      newStatus,
      actor,
      errorReason,
      errorDetail,
    });
  });
}

/** Transition the run to failed with a closed-enum reason + sanitized detail. */
async function failRun(
  ctx: RunContext,
  errorReason: NonNullable<AgentRunFrontmatter['error_reason']>,
  errorDetail: string,
): Promise<void> {
  await txWithEventsTransition(ctx.run.id, ctx.transitionActor, 'failed', errorReason, errorDetail);
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
  const actor = runRow?.createdBy ?? '';
  try {
    await txWithEventsTransition(
      runId,
      actor,
      'failed',
      runErrorReasonSchema.enum.provider_error,
      sanitizeProviderError(err, providerLabel),
    );
  } catch (transitionErr) {
    const code = (transitionErr as { code?: string } | undefined)?.code;
    if (code === 'RUN_TRANSITION_RACED' || code === 'INVALID_RUN_TRANSITION') {
      // Run is already terminal — nothing more to do.
      return;
    }
    console.error(`[runner] last-resort failure transition for run ${runId} threw:`, transitionErr);
  }
}
