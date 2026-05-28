import { z } from 'zod';

export const RunStatusSchema = z.enum([
  'planning',
  'awaiting_approval',
  'running',
  'completed',
  'failed',
  'rejected',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunErrorReasonSchema = z.enum([
  'budget_exceeded',
  'depth_exceeded',
  'no_ai_key',
  'provider_error',
  'cancelled',
  'rejected',
  'idempotency_violation',
  'rate_limited',
  'fanout_exceeded',
  'chain_duration_exceeded',
  'chain_tokens_exceeded',
  'worker_crash',
]);
export type RunErrorReason = z.infer<typeof RunErrorReasonSchema>;

export const ProviderSchema = z.enum(['anthropic', 'openai', 'openrouter', 'ollama']);
export type Provider = z.infer<typeof ProviderSchema>;

export const AgentRunFrontmatterSchema = z.object({
  assignee: z.string().regex(/^agent:.+$/),
  status: RunStatusSchema,

  agent_slug: z.string(),
  provider: ProviderSchema,
  model: z.string(),
  system_prompt: z.string(),
  max_tokens: z.number().int().positive(),

  tokens_in: z.number().int().nonnegative().default(0),
  tokens_out: z.number().int().nonnegative().default(0),

  trigger_id: z.string().nullable(),
  chain_id: z.string().uuid(),
  fired_by: z.string(),

  started_at: z.string().datetime(),
  completed_at: z.string().datetime().optional(),

  worker_started_at: z.string().datetime().optional(),

  // Set on resume — points to the original awaiting_approval run id.
  resume_of: z.string().optional(),

  error_reason: RunErrorReasonSchema.optional(),
  error_detail: z.string().optional(),
});
export type AgentRunFrontmatter = z.infer<typeof AgentRunFrontmatterSchema>;

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
