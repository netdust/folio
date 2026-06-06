/**
 * Instance-level key/value settings (the `instance_settings` table).
 *
 * Currently holds the `operator_model` setting: which configured provider+model
 * the operator runs on (replacing the hardcoded default in lib/operator.ts).
 * Reads AND writes validate through the ONE shared `operatorModelSettingSchema`
 * (@folio/shared) — so the route validator, the setter, and the tolerant reader
 * can't drift. The read is tolerant (a missing/corrupt/wrong-shape row → null
 * via safeParse) so the consumer (loadConversationContext) falls back to the
 * default rather than crashing every operator run (threat model M7). The setter
 * also validates (M6) so the write and read paths agree.
 */

import { eq } from 'drizzle-orm';
import { operatorModelSettingSchema, type OperatorModelSetting } from '@folio/shared';
import type { DB } from '../db/client.ts';
import { instanceSettings } from '../db/schema.ts';

const OPERATOR_MODEL_KEY = 'operator_model';

export type { OperatorModelSetting };

/**
 * Read the operator-model setting, tolerant of a missing/corrupt/wrong-shape row
 * (→ null). One shared schema (`safeParse`) is the validator — unknown provider,
 * empty model/label, non-object value all degrade to null, never throw.
 */
export async function getOperatorModelSetting(db: DB): Promise<OperatorModelSetting | null> {
  const row = await db.query.instanceSettings.findFirst({
    where: eq(instanceSettings.key, OPERATOR_MODEL_KEY),
  });
  if (!row) return null;
  const parsed = operatorModelSettingSchema.safeParse(row.value);
  return parsed.success ? parsed.data : null;
}

/**
 * Upsert the operator-model setting (one row, keyed by `operator_model`).
 * Validates through the shared schema (M6) so a caller can't persist a value the
 * reader would reject — write and read agree. Throws on an invalid value.
 */
export async function setOperatorModelSetting(db: DB, v: OperatorModelSetting): Promise<void> {
  // Validate + normalize (applies the aiKeyLabel default) before persisting.
  const value = operatorModelSettingSchema.parse(v) as Record<string, unknown>;
  await db
    .insert(instanceSettings)
    .values({ key: OPERATOR_MODEL_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: instanceSettings.key,
      set: { value, updatedAt: new Date() },
    });
}
