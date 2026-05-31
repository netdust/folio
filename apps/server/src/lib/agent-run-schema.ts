import { z } from 'zod';

export const runStatusSchema = z.enum([
  'planning',
  'awaiting_approval',
  'running',
  'completed',
  'failed',
  'rejected',
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const runErrorReasonSchema = z.enum([
  'budget_exceeded',
  'depth_exceeded',
  'no_ai_key',
  'provider_error',
  // D-9.1 — runner gave up after N consecutive recoverable tool errors
  // (model couldn't self-correct). Distinct from 'provider_error' (hard
  // provider/transport failure). Mitigation 64: excluded from
  // checkProviderHealth's allow-list filter, so it never degrades a
  // provider — a model-recovery failure is not a provider signal.
  'tool_error',
  'cancelled',
  'rejected',
  'idempotency_violation',
  'rate_limited',
  'fanout_exceeded',
  'chain_duration_exceeded',
  'chain_tokens_exceeded',
  'worker_crash',
  // The agent's prompt (its document body) was empty at run/resume time — the
  // agent was misconfigured (body cleared). Distinct from a provider/transport
  // fault: a config error the operator must fix, not a retryable failure.
  'prompt_empty',
]);
export type RunErrorReason = z.infer<typeof runErrorReasonSchema>;

/**
 * Round 7 #20 — round 4 widened `ProviderEvent.done.reason` to include
 * 'refusal' and 'pause_turn'. The persistence schema previously had no slot
 * to store them. Sub-phase C runner would have had to drop the signal
 * (collapsing to status='completed' — operator-confusing), collapse to
 * error_reason='provider_error' (lossy), or invent a field (drift).
 *
 * The runner persists this value directly from the done event. 'refusal'
 * and 'pause_turn' both terminate the run as status='completed' but with
 * done_reason distinguishing them from clean completion. Operator dashboards
 * can branch on done_reason='refusal' to triage safety stops.
 *
 * Mirror of `ProviderEvent.done.reason` in `apps/server/src/lib/ai/provider.ts`.
 * Threat model mitigation 20.
 */
export const runDoneReasonSchema = z.enum([
  'stop',
  'tool_use',
  'max_tokens',
  'refusal',
  'pause_turn',
]);
export type RunDoneReason = z.infer<typeof runDoneReasonSchema>;

export const providerSchema = z.enum(['anthropic', 'openai', 'openrouter', 'ollama']);
export type Provider = z.infer<typeof providerSchema>;

export const agentRunFrontmatterSchema = z
  .object({
    assignee: z.string().regex(/^agent:[a-z0-9-]+$/),
    status: runStatusSchema,

    agent_slug: z.string().regex(/^[a-z0-9-]+$/),
    provider: providerSchema,
    model: z.string(),
    system_prompt: z.string(),
    max_tokens: z.number().int().positive(),

    tokens_in: z.number().int().nonnegative().default(0),
    tokens_out: z.number().int().nonnegative().default(0),

    trigger_id: z.string().nullable(),
    chain_id: z.string().uuid(),
    fired_by: z.string(),

    started_at: z.string().datetime(),
    // ISO 8601 timestamp with `Z` suffix only — Zod's .datetime() defaults
    // to `offset: false` which rejects `+HH:MM`-style offsets at parse
    // time. This enforcement is what makes the
    // `json_extract(...worker_started_at) < ${threshold}` lex-compare in
    // recoverOrphanRuns safe (F13 audit — fixed-width UTC ISO sorts
    // chronologically; offset-tagged ISOs would sort before `Z`). Don't
    // pass `{ offset: true }` here without re-thinking the orphan-recovery
    // predicate.
    completed_at: z.string().datetime().optional(),

    worker_started_at: z.string().datetime().optional(),

    // Set on resume — points to the original awaiting_approval run id. Run ids
    // are `nanoid()` (see createRun), NOT UUIDs, so this is a plain non-empty
    // string, not `.uuid()` (D-5 — the resume_run internal_action writes the
    // original nanoid run id here via createRun's `resumeOf`).
    resume_of: z.string().min(1).optional(),

    error_reason: runErrorReasonSchema.optional(),
    error_detail: z.string().optional(),

    // Round 7 #20 — see runDoneReasonSchema above. Optional because:
    //   (a) rows persisted before the Sub-phase C runner exists won't have it,
    //   (b) rows in non-terminal status haven't received a done event yet,
    //   (c) terminal status='failed' / 'rejected' use error_reason instead.
    done_reason: runDoneReasonSchema.optional(),
  })
  .strict();
export type AgentRunFrontmatter = z.infer<typeof agentRunFrontmatterSchema>;

export const TERMINAL_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'rejected'];

/**
 * State machine for agent_run rows. Any transition out of a terminal state
 * is invalid; the dispatcher rejects out-of-machine transitions before the
 * row is updated.
 */
const TRANSITIONS: Record<RunStatus, ReadonlyArray<RunStatus>> = {
  planning: ['awaiting_approval', 'running', 'failed'],
  awaiting_approval: ['running', 'rejected', 'failed'],
  running: ['completed', 'failed'],
  completed: [],
  failed: [],
  rejected: [],
};

export function isValidTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].includes(to);
}
