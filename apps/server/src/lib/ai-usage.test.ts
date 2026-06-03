import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { aiUsage } from '../db/schema.ts';
import { makeTestApp } from '../test/harness.ts';
import { recordAiUsage } from './ai-usage.ts';

describe('recordAiUsage (M8 — record, not enforce)', () => {
  test('inserts an ai_usage row attributed to the run workspace', async () => {
    const { db } = await makeTestApp();
    await recordAiUsage(db, {
      workspaceId: 'w-1',
      runId: 'r-1',
      provider: 'ollama',
      label: 'default',
      tokensIn: 10,
      tokensOut: 5,
    });
    const rows = await db.query.aiUsage.findMany({ where: eq(aiUsage.runId, 'r-1') });
    expect(rows.length).toBe(1);
    expect(rows[0]!.workspaceId).toBe('w-1');
    expect(rows[0]!.provider).toBe('ollama');
    expect(rows[0]!.label).toBe('default');
    expect(rows[0]!.tokensIn).toBe(10);
    expect(rows[0]!.tokensOut).toBe(5);
  });

  test('a failing insert does NOT throw (metering is best-effort, must not fail the run)', async () => {
    const { db } = await makeTestApp();
    // A non-null violation (missing runId via a forced bad call) must be swallowed.
    // Force failure by passing an undefined required field through a cast.
    await expect(
      recordAiUsage(db, {
        workspaceId: 'w-2',
        // @ts-expect-error — deliberately omit runId to force a NOT NULL failure
        runId: undefined,
        provider: 'ollama',
        label: 'default',
        tokensIn: 1,
        tokensOut: 1,
      }),
    ).resolves.toBeUndefined();
  });
});
