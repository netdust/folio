/**
 * Operator-run error surfacing — a conversation (cockpit) run that THROWS must
 * post ONE sanitized `kind:'text'` operator message into the thread (so the
 * cockpit isn't a silent dead chat) AND clear its single-active-turn slot.
 *
 * The bug this guards: failRunLastResort only transitioned an `agent_run`
 * DOCUMENT row; a conversation run has no such row, so a provider 402/401/5xx
 * (or any throw) logged to stderr and returned — the user saw nothing.
 *
 * Harness mirrors runner.test.ts: makeTestApp + seedInstanceSkills + an
 * anthropic 'default' key (preflight needs key PRESENCE) + a provider stub.
 * The novel piece is a stub whose stream THROWS, driving the top-level catch
 * through the PUBLIC runAgent (plan option b — closest to real). The provider
 * hatch is reset in afterEach (see [[mock-module-leaks-across-bun-tests]]).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { aiKeys, conversations, messages } from '../db/schema.ts';
import { nanoid } from 'nanoid';
import type { AIProvider } from './ai/provider.ts';
import { __INTERNAL_TEST_ONLY__ as providerTestHatch } from './ai/provider.ts';
import { conversationBus } from './conversation-bus.ts';
import { encryptSecret } from './crypto.ts';
import { seedInstanceSkills } from './instance-skills.ts';
import { runAgent } from './runner.ts';
import { createConversation } from '../services/conversations.ts';
import { createConversationRun } from '../services/conversation-runs.ts';
import { makeTestApp } from '../test/harness.ts';

afterEach(() => {
  providerTestHatch.reset();
});

/** Install a provider stub whose `stream` THROWS the given error on first pull. */
function installThrowingProviderStub(err: Error): void {
  const stub: AIProvider = {
    // eslint-disable-next-line require-yield
    async *stream() {
      throw err;
    },
    async testKey() {
      return { ok: true as const };
    },
  };
  providerTestHatch.overrideRegistry('anthropic', async () => stub);
}

/** Install a provider stub that yields a single text + clean done (a healthy turn). */
function installHealthyProviderStub(): void {
  const stub: AIProvider = {
    async *stream() {
      yield { type: 'text', delta: 'All done.' } as const;
      yield { type: 'done', reason: 'stop' } as const;
    },
    async testKey() {
      return { ok: true as const };
    },
  };
  providerTestHatch.overrideRegistry('anthropic', async () => stub);
}

/**
 * Reproduce what the route's startTurn + runner do: seed skills + key, create a
 * conversation + run, acquire the slot, then drive runAgent to completion. The
 * provider stub (installed by the caller) decides success vs throw.
 */
async function driveConversationRun(
  db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  userId: string,
): Promise<{ convId: string; runId: string }> {
  await seedInstanceSkills(db);
  await db.insert(aiKeys).values({
    id: nanoid(),
    provider: 'anthropic',
    label: 'default',
    encryptedKey: encryptSecret('sk-test-fake-key'),
  });
  const conv = await createConversation(db, {
    createdBy: userId,
    operatorAgentId: '_operator',
    title: 'Untitled',
  });
  const runId = nanoid();
  await createConversationRun(db, {
    conversation: { id: conv.id, createdBy: userId },
    runId,
  });
  // Mirror the route's CAS acquire so we can assert the slot is RELEASED after.
  await db.update(conversations).set({ activeRunId: runId }).where(eq(conversations.id, conv.id));
  await runAgent({ runId });
  return { convId: conv.id, runId };
}

describe('operator-run error surfacing', () => {
  // AF1 + AF2 + M1/M4
  test('a failed conversation run posts ONE sanitized error into the thread; slot cleared', async () => {
    const { db, seed } = await makeTestApp();
    // The thrown error intentionally embeds a SECRET-shaped token (T1/M1).
    installThrowingProviderStub(new Error('upstream said sk-or-v1-LEAKME-402 payment required'));

    const { convId } = await driveConversationRun(db, seed.user.id);

    const rows = await db.query.messages.findMany({
      where: eq(messages.conversationId, convId),
      orderBy: (m, { asc }) => [asc(m.seq)],
    });
    const errorRows = rows.filter((r) => r.role === 'operator' && r.kind === 'text');
    // M4: exactly ONE terminal error row.
    expect(errorRows.length).toBe(1);
    expect(errorRows[0]!.body ?? '').toMatch(/couldn.t complete this turn/i);
    // AF2/M1: the secret-shaped substring is absent from EVERY message body.
    for (const r of rows) expect(r.body ?? '').not.toContain('sk-or-v1-LEAKME');

    // A3: the single-active-turn slot is released (NOT wedged at 409).
    const convRow = await db.query.conversations.findFirst({ where: eq(conversations.id, convId) });
    expect(convRow?.activeRunId).toBeNull();
  });

  // M3 — surfacing the error must be BEST-EFFORT: a throw inside the surface
  // write must not prevent the slot from clearing (the slot clears in the
  // finally, BEFORE failRunLastResort runs) nor crash the run path.
  test('slot still clears when the error-surfacing write throws (M3)', async () => {
    const { db, seed } = await makeTestApp();
    installThrowingProviderStub(new Error('402 payment required'));

    // Force the surface publish to throw. The bus is a singleton object; patch
    // its method and restore it in finally (leak-free — no module mock).
    const realPublish = conversationBus.publish.bind(conversationBus);
    conversationBus.publish = () => {
      throw new Error('bus exploded');
    };
    let convId: string;
    try {
      ({ convId } = await driveConversationRun(db, seed.user.id));
    } finally {
      conversationBus.publish = realPublish;
    }

    // A3/M3: slot cleared despite the surface throw.
    const convRow = await db.query.conversations.findFirst({ where: eq(conversations.id, convId!) });
    expect(convRow?.activeRunId).toBeNull();
  });

  // AF3 — a HEALTHY run must NOT append a terminal error row (the catch never fires).
  test('a successful conversation run appends no terminal error row (AF3)', async () => {
    const { db, seed } = await makeTestApp();
    installHealthyProviderStub();

    const { convId } = await driveConversationRun(db, seed.user.id);

    const rows = await db.query.messages.findMany({ where: eq(messages.conversationId, convId) });
    const erroredText = rows.filter(
      (r) => r.role === 'operator' && r.kind === 'text' && /couldn.t complete this turn/i.test(r.body ?? ''),
    );
    expect(erroredText.length).toBe(0);
    // The slot is released on the clean path too.
    const convRow = await db.query.conversations.findFirst({ where: eq(conversations.id, convId) });
    expect(convRow?.activeRunId).toBeNull();
  });

  // code-review #3 — a PRE-CONTEXT throw (loadContext itself fails) must STILL
  // surface the error + clear the slot. The caller captures conversationId only
  // after loadContext returns, so failRunLastResort must resolve the conversation
  // from the run binding (active_run_id = runId). Without that, a loadContext throw
  // left the cockpit silently wedged at 409 until reboot.
  test('a loadContext-stage throw still surfaces an error AND clears the slot (#3)', async () => {
    const { db, seed } = await makeTestApp();
    // A healthy stub — the failure we want is BEFORE the stream, at loadContext.
    installHealthyProviderStub();
    await seedInstanceSkills(db);
    await db.insert(aiKeys).values({
      id: nanoid(),
      provider: 'anthropic',
      label: 'default',
      encryptedKey: encryptSecret('sk-test-fake-key'),
    });
    const conv = await createConversation(db, {
      createdBy: seed.user.id,
      operatorAgentId: '_operator',
      title: 'Untitled',
    });
    const runId = nanoid();
    await createConversationRun(db, { conversation: { id: conv.id, createdBy: seed.user.id }, runId });
    await db.update(conversations).set({ activeRunId: runId }).where(eq(conversations.id, conv.id));

    // Force loadContext to throw AFTER the slot is acquired: remove the operator's
    // definitional skills so loadAgentDefinition throws MISSING_SKILL mid-load.
    const { instanceSkills } = await import('../db/schema.ts');
    await db.delete(instanceSkills);

    await runAgent({ runId });

    // The slot is cleared (NOT wedged) even though the throw was pre-context...
    const convRow = await db.query.conversations.findFirst({ where: eq(conversations.id, conv.id) });
    expect(convRow?.activeRunId).toBeNull();
    // ...AND an error was surfaced into the thread (resolved via the run binding).
    const rows = await db.query.messages.findMany({ where: eq(messages.conversationId, conv.id) });
    const errorRows = rows.filter((r) => r.role === 'operator' && r.kind === 'text' && /couldn.t complete this turn/i.test(r.body ?? ''));
    expect(errorRows.length).toBe(1);
  });

  // code-review #4 — a CONVERSATION run that hits max_tokens with a pending tool
  // call must post EXACTLY ONE thread message. The old dropped-call path called
  // postAgentComment (→ sink.text) AND failRun (→ sink.text), double-posting on the
  // cockpit thread. Now failRun is the single surface.
  test('a conversation max_tokens-truncated tool turn posts exactly ONE thread message (#4)', async () => {
    const { db, seed } = await makeTestApp();
    // A stub: stream a tool_call, then finish with max_tokens (truncation).
    const stub: AIProvider = {
      async *stream() {
        yield { type: 'tool_call', id: 'tc-1', name: 'list_workspaces', arguments: {} } as const;
        yield { type: 'done', reason: 'max_tokens' } as const;
      },
      async testKey() {
        return { ok: true as const };
      },
    };
    providerTestHatch.overrideRegistry('anthropic', async () => stub);

    const { convId } = await driveConversationRun(db, seed.user.id);

    const rows = await db.query.messages.findMany({
      where: eq(messages.conversationId, convId),
      orderBy: (m, { asc }) => [asc(m.seq)],
    });
    // EXACTLY ONE operator text message about the failure — not two.
    const opText = rows.filter((r) => r.role === 'operator' && r.kind === 'text');
    expect(opText.length).toBe(1);
    expect(opText[0]!.body ?? '').toMatch(/could not finish this turn/i);
  });

  // code-review (re-review sibling) — the MID-STREAM budget-cap path is the same
  // double-post mode as #4: a conversation run that exceeds max_tokens mid-stream
  // posted postAgentComment (→sink.text) AND failRun (→sink.text). Unlike
  // handleCancel this IS reachable on the conversation path (budget tracking runs
  // for sink runs). Must post exactly ONE thread message.
  test('a conversation run that exceeds the mid-stream budget cap posts exactly ONE thread message', async () => {
    const { db, seed } = await makeTestApp();
    // Stream a tokens event over the operator's 100k cap → mid-stream budget break.
    const stub: AIProvider = {
      async *stream() {
        yield { type: 'text', delta: 'working' } as const;
        yield { type: 'tokens', tokens_in: 60_000, tokens_out: 60_000 } as const;
        yield { type: 'done', reason: 'stop' } as const;
      },
      async testKey() {
        return { ok: true as const };
      },
    };
    providerTestHatch.overrideRegistry('anthropic', async () => stub);

    const { convId } = await driveConversationRun(db, seed.user.id);

    const rows = await db.query.messages.findMany({
      where: eq(messages.conversationId, convId),
      orderBy: (m, { asc }) => [asc(m.seq)],
    });
    const opText = rows.filter((r) => r.role === 'operator' && r.kind === 'text');
    expect(opText.length).toBe(1);
    expect(opText[0]!.body ?? '').toMatch(/could not finish this turn/i);
  });
});
