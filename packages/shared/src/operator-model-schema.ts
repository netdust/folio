import { z } from 'zod';
import { AI_PROVIDERS } from './ai-providers.ts';

/**
 * The operator-model selection contract: which configured provider + model +
 * key-label the operator runs on. The SINGLE source of this shape — the server
 * route validator, the instance-settings setter, AND the tolerant reader all use
 * this one schema (previously the {provider, model, aiKeyLabel} shape was
 * hand-restated 3-4× and could drift). `safeParse` gives the tolerant read for
 * free (returns success:false on any malformed/wrong-shape value, never throws).
 */
/**
 * The provider set the OPERATOR may run on: the four keyed providers PLUS the
 * keyless local `claude-code` backend (attended-only, env-gated at runtime —
 * see runner.ts ccGateBlocks). This is INTENTIONALLY wider than `AI_PROVIDERS`
 * (which stays the keyed set used for key-CRUD + key-resolution logic): cc
 * carries no secret and gets no `ai_keys` row, so it must never enter the keyed
 * paths — only this operator-selection contract.
 */
export const OPERATOR_MODEL_PROVIDERS = [...AI_PROVIDERS, 'claude-code'] as const;

export const operatorModelSettingSchema = z
  .object({
    provider: z.enum(OPERATOR_MODEL_PROVIDERS),
    model: z.string().min(1),
    aiKeyLabel: z.string().min(1).default('default'),
  })
  .strict();

export type OperatorModelSetting = z.infer<typeof operatorModelSettingSchema>;
