/**
 * Instance-level key/value settings (the `instance_settings` table).
 *
 * Currently holds the `operator_model` setting: which configured provider+model
 * the operator runs on (replacing the hardcoded default in lib/operator.ts).
 * Reads are TOLERANT — a missing or corrupt/wrong-shape row degrades to `null`
 * so the consumer (getOperatorDefinition) falls back to the default rather than
 * crashing every operator run (threat model M7). The setter is upsert-by-key.
 */

import { eq } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { instanceSettings } from '../db/schema.ts';

const OPERATOR_MODEL_KEY = 'operator_model';

/** A configured provider — the closed set, kept in lockstep with ai_keys.provider. */
const PROVIDERS = new Set(['anthropic', 'openai', 'openrouter', 'ollama']);

export interface OperatorModelSetting {
  provider: 'anthropic' | 'openai' | 'openrouter' | 'ollama';
  model: string;
  aiKeyLabel: string;
}

/**
 * Read the operator-model setting, tolerant of a missing/corrupt/wrong-shape row
 * (→ null). Validates the provider against the closed enum (M6) and that
 * model/aiKeyLabel are non-empty strings — a row failing any check degrades to
 * null, never throws.
 */
export async function getOperatorModelSetting(db: DB): Promise<OperatorModelSetting | null> {
  const row = await db.query.instanceSettings.findFirst({
    where: eq(instanceSettings.key, OPERATOR_MODEL_KEY),
  });
  if (!row) return null;
  const v = row.value as Record<string, unknown> | null | undefined;
  if (
    !v ||
    typeof v !== 'object' ||
    typeof v.provider !== 'string' ||
    !PROVIDERS.has(v.provider) ||
    typeof v.model !== 'string' ||
    v.model.length === 0 ||
    typeof v.aiKeyLabel !== 'string' ||
    v.aiKeyLabel.length === 0
  ) {
    return null;
  }
  return {
    provider: v.provider as OperatorModelSetting['provider'],
    model: v.model,
    aiKeyLabel: v.aiKeyLabel,
  };
}

/** Upsert the operator-model setting (one row, keyed by `operator_model`). */
export async function setOperatorModelSetting(db: DB, v: OperatorModelSetting): Promise<void> {
  await db
    .insert(instanceSettings)
    .values({ key: OPERATOR_MODEL_KEY, value: v, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: instanceSettings.key,
      set: { value: v, updatedAt: new Date() },
    });
}
