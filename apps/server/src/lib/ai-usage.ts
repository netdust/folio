import { nanoid } from 'nanoid';
import type { DB } from '../db/client.ts';
import { aiUsage } from '../db/schema.ts';

/** M8 metering — RECORD usage, do NOT enforce. Attributes shared-instance-key
 *  usage to the run's workspace so the denial-of-wallet residual is detectable +
 *  attributable. Per-key caps/enforcement are a deferred phase (see the spec).
 *  Failure here must NOT fail the run — log + continue (metering is best-effort
 *  observability, never on the run's critical path). */
export async function recordAiUsage(
  db: DB,
  args: {
    workspaceId: string;
    runId: string;
    provider: string;
    label: string;
    tokensIn: number;
    tokensOut: number;
  },
): Promise<void> {
  try {
    await db.insert(aiUsage).values({ id: nanoid(), ...args });
  } catch (err) {
    console.warn('[ai-usage] failed to record usage:', err instanceof Error ? err.message : err);
  }
}
