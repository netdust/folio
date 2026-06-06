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
export const operatorModelSettingSchema = z
  .object({
    provider: z.enum(AI_PROVIDERS),
    model: z.string().min(1),
    aiKeyLabel: z.string().min(1).default('default'),
  })
  .strict();

export type OperatorModelSetting = z.infer<typeof operatorModelSettingSchema>;
