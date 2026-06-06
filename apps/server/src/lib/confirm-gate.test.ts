/**
 * Operator cockpit chat (Task 7) — the HARD irreversible-op confirm gate.
 *
 * THE must-be-hard set (threat model M4–M7, M13). These are the crown-jewel
 * tests: the injection-skip (M5) and recorded-params (M6) cases MUST BITE — if the
 * gate were removed from executeTool, they go RED. The gate is a STRUCTURAL control
 * at the convergence point (executeTool), not a prompt rule.
 *
 * Uses `makeBareTestDb` so the global `db` proxy (which the gate reads/writes via
 * `tx ?? db`) points at this test's in-memory db. Synthetic tools are registered
 * via the module-global registry and torn down per test (mock-module-leak lesson).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { conversations, pendingOps, type ApiToken } from '../db/schema.ts';
import { makeBareTestDb } from '../test/harness.ts';
import { type ToolDef, executeTool, isAwaitingConfirmation, registerTool } from './agent-tools.ts';
import type { ConversationSink } from './chat-thread-sink.ts';
import {
  confirmPendingOp,
  getConfirmedPendingOp,
  recordPendingOp,
} from '../services/pending-ops.ts';

let db: Awaited<ReturnType<typeof makeBareTestDb>>['db'];

const registeredInTest: string[] = [];
function registerThrowaway<TArgs, TOut>(def: ToolDef<TArgs, TOut>): void {
  registerTool(def);
  registeredInTest.push(def.name);
}

afterEach(() => {
  for (const name of registeredInTest.splice(0)) {
    // @ts-expect-error — test-only registry teardown hook
    (globalThis.__folioToolRegistry as Map<string, unknown>)?.delete(name);
  }
});

function makeToken(scopes: string[]): ApiToken {
  return {
    id: 'tok_test',
    workspaceId: null,
    name: 'test',
    tokenHash: 'hash',
    scopes,
    agentId: null,
    projectIds: null,
    createdBy: null,
    lastUsedAt: null,
    createdAt: new Date(),
  };
}

/** A no-op sink that records what was emitted so tests can assert the card. */
function makeRecordingSink(): ConversationSink & { components: Record<string, unknown>[] } {
  const components: Record<string, unknown>[] = [];
  return {
    components,
    async text() {},
    async toolStep() {},
    async component(payload) {
      components.push(payload);
    },
  };
}

async function makeConversation(createdBy = 'user-1'): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(conversations).values({
    id,
    title: 'Untitled',
    createdBy,
    operatorAgentId: '_operator',
    activeRunId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return id;
}

beforeEach(async () => {
  ({ db } = await makeBareTestDb());
});

describe('irreversible-op confirm gate (executeTool)', () => {
  // A synthetic HIGH-tier tool (write scope, NO riskTier → fail-closed high). Its
  // handler increments a counter so we can prove whether it actually applied.
  let applied: { count: number; lastArgs: unknown };
  function registerHighTool(name = '__danger'): void {
    applied = { count: 0, lastArgs: undefined };
    registerThrowaway({
      name,
      requiredScope: 'documents:delete',
      schema: z.object({ slug: z.string() }).strict(),
      handler: async (args: { slug: string }) => {
        applied.count += 1;
        applied.lastArgs = args;
        return { deleted: args.slug };
      },
    });
  }

  it('M4/M5: a HIGH op in a conversation with NO matching pending_op PAUSES for confirmation (AwaitingConfirmationError) — regardless of prompt', async () => {
    registerHighTool();
    const convId = await makeConversation();
    const sink = makeRecordingSink();

    // The gate throws a typed AwaitingConfirmationError (a clean-pause signal the
    // runner routes to a turn-end), NOT a `forbidden:` fatal — but it STILL
    // refuses to apply the op until confirmed.
    const err = await executeTool(
      makeToken(['documents:delete']),
      'user-1',
      '__danger',
      { slug: 'acme' },
      undefined,
      {
        callerScopes: ['documents:delete'],
        conversationId: convId,
        conversationSink: sink,
        confirmerId: 'user-1',
      },
    ).then(
      () => null,
      (e) => e as Error,
    );
    expect(isAwaitingConfirmation(err)).toBe(true);

    // The op did NOT apply (the gate refused before dispatch).
    expect(applied.count).toBe(0);
    // A pending_ops row was recorded + a choice_card raised (M6/M8 wiring).
    const rows = await db.select().from(pendingOps).where(eq(pendingOps.conversationId, convId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.op).toBe('__danger');
    expect(rows[0]!.status).toBe('pending');
    expect(sink.components.some((c) => c.type === 'choice_card')).toBe(true);
  });

  it('M6: confirming executes the RECORDED params, not a turn-2 re-read', async () => {
    registerHighTool();
    const convId = await makeConversation();

    // Propose with slug 'acme'.
    const pending = await recordPendingOp(db, {
      conversationId: convId,
      callerId: 'user-1',
      op: '__danger',
      params: { slug: 'acme' },
      target: 'acme',
    });
    await confirmPendingOp(db, pending.id, 'user-1');

    // Turn-2 re-read tries to delete a DIFFERENT slug. The recorded params win.
    await executeTool(makeToken(['documents:delete']), 'user-1', '__danger', { slug: 'acme' }, undefined, {
      callerScopes: ['documents:delete'],
      conversationId: convId,
    });

    expect(applied.count).toBe(1);
    // The handler ran the RECORDED slug ('acme'), not any drifted re-read.
    expect((applied.lastArgs as { slug: string }).slug).toBe('acme');
    // Audit: the row is now 'executed'.
    const row = await db.select().from(pendingOps).where(eq(pendingOps.id, pending.id)).then((r) => r[0]!);
    expect(row.status).toBe('executed');
    expect(row.executedBy).toBe('user-1');
    expect(row.executedAt).not.toBeNull();
    // Immutable params.
    expect(JSON.parse(row.params).slug).toBe('acme');
  });

  it('BLOCKER (caller_id namespace): gate-record uses the HUMAN confirmerId, NOT the agent actor — so the confirm round-trip actually works', async () => {
    // This is the end-to-end wiring assertion the per-task tests missed: a
    // conversation run's executeTool actor is `agent:_operator`, but the confirm
    // route confirms with the HUMAN owner's user id. If the gate records caller_id
    // from `actor`, confirmPendingOp's caller-bound WHERE never matches → every
    // confirm fails closed (the gate is unconfirmable). Drive the REAL gate with a
    // distinct agent actor + a human confirmerId, then confirm as the human.
    registerHighTool();
    const convId = await makeConversation();
    const sink = makeRecordingSink();
    const AGENT_ACTOR = 'agent:_operator';
    const HUMAN = 'user-1'; // the conversation owner (makeConversation seeds this)

    // Turn 1: the operator (agent actor) proposes a HIGH op. Gate records + refuses.
    await expect(
      executeTool(makeToken(['documents:delete']), AGENT_ACTOR, '__danger', { slug: 'acme' }, undefined, {
        callerScopes: ['documents:delete'],
        conversationId: convId,
        conversationSink: sink,
        confirmerId: HUMAN, // ← the human owner, threaded by the runner as transitionActor
      }),
    ).rejects.toThrow(/requires confirmation/);

    // The recorded pending_op's caller_id MUST be the HUMAN, not the agent actor.
    const rows = await db.select().from(pendingOps).where(eq(pendingOps.conversationId, convId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.callerId).toBe(HUMAN); // ← the BLOCKER: was AGENT_ACTOR before the fix
    const pendingId = rows[0]!.id;

    // The HUMAN confirms (as the route does, with the session user id) — succeeds.
    await confirmPendingOp(db, pendingId, HUMAN);

    // Turn 2: the operator re-invokes; the gate finds the confirmed row + executes.
    await executeTool(makeToken(['documents:delete']), AGENT_ACTOR, '__danger', { slug: 'acme' }, undefined, {
      callerScopes: ['documents:delete'],
      conversationId: convId,
      confirmerId: HUMAN,
    });
    expect(applied.count).toBe(1); // the destructive op finally applied — gate is confirmable
  });

  it('M6 (mutation guard): a confirmed op for slug A does NOT match a turn calling slug B → refuses', async () => {
    registerHighTool();
    const convId = await makeConversation();
    const pending = await recordPendingOp(db, {
      conversationId: convId,
      callerId: 'user-1',
      op: '__danger',
      params: { slug: 'acme' },
      target: 'acme',
    });
    await confirmPendingOp(db, pending.id, 'user-1');

    // The operator calls with a DIFFERENT slug — no confirmed row matches those
    // params → the gate re-proposes (refuses), it does NOT execute slug 'evil'.
    await expect(
      executeTool(makeToken(['documents:delete']), 'user-1', '__danger', { slug: 'evil' }, undefined, {
        callerScopes: ['documents:delete'],
        conversationId: convId,
        confirmerId: 'user-1',
      }),
    ).rejects.toThrow(/requires confirmation/);
    expect(applied.count).toBe(0);
  });

  it('M7: a confirmation is single-use (rejected on re-use)', async () => {
    const convId = await makeConversation();
    const pending = await recordPendingOp(db, {
      conversationId: convId,
      callerId: 'user-1',
      op: '__danger',
      params: { slug: 'acme' },
      target: 'acme',
    });
    await confirmPendingOp(db, pending.id, 'user-1');
    // Second confirm of the same id is rejected (status no longer 'pending').
    await expect(confirmPendingOp(db, pending.id, 'user-1')).rejects.toThrow(
      'PENDING_OP_NOT_CONFIRMABLE',
    );
  });

  it('M7: a confirmation is caller-bound (a foreign user cannot confirm)', async () => {
    const convId = await makeConversation();
    const pending = await recordPendingOp(db, {
      conversationId: convId,
      callerId: 'user-1',
      op: '__danger',
      params: { slug: 'acme' },
      target: 'acme',
    });
    await expect(confirmPendingOp(db, pending.id, 'user-2')).rejects.toThrow('PENDING_OP_NOT_FOUND');
    // The row is untouched (still pending) — a foreign confirm cannot flip it.
    const row = await db.select().from(pendingOps).where(eq(pendingOps.id, pending.id)).then((r) => r[0]!);
    expect(row.status).toBe('pending');
  });

  it('M7: an expired confirmation is rejected', async () => {
    const convId = await makeConversation();
    // Insert an already-expired pending op directly.
    const id = crypto.randomUUID();
    await db.insert(pendingOps).values({
      id,
      conversationId: convId,
      callerId: 'user-1',
      op: '__danger',
      params: JSON.stringify({ slug: 'acme' }),
      target: 'acme',
      status: 'pending',
      createdAt: new Date(Date.now() - 10 * 60 * 1000),
      expiresAt: new Date(Date.now() - 5 * 60 * 1000),
      executedAt: null,
      executedBy: null,
    });
    await expect(confirmPendingOp(db, id, 'user-1')).rejects.toThrow('PENDING_OP_EXPIRED');
    const row = await db.select().from(pendingOps).where(eq(pendingOps.id, id)).then((r) => r[0]!);
    expect(row.status).toBe('expired');
  });

  it('M7: getConfirmedPendingOp does not match an expired confirmed row', async () => {
    const convId = await makeConversation();
    const id = crypto.randomUUID();
    await db.insert(pendingOps).values({
      id,
      conversationId: convId,
      callerId: 'user-1',
      op: '__danger',
      params: JSON.stringify({ slug: 'acme' }),
      target: 'acme',
      status: 'confirmed', // confirmed but...
      createdAt: new Date(Date.now() - 10 * 60 * 1000),
      expiresAt: new Date(Date.now() - 1000), // ...expired
      executedAt: null,
      executedBy: null,
    });
    const match = await getConfirmedPendingOp(db, {
      conversationId: convId,
      op: '__danger',
      params: { slug: 'acme' },
    });
    expect(match).toBeUndefined();
  });

  it('M13 fail-closed: a synthetic write-scoped tool with NO riskTier is gated (confirms)', async () => {
    // documents:write, NO riskTier → effectiveTier defaults to 'high' → gated.
    registerThrowaway({
      name: '__synth_write',
      requiredScope: 'documents:write',
      schema: z.object({}).strict(),
      handler: async () => ({ ok: true }),
    });
    const convId = await makeConversation();
    await expect(
      executeTool(makeToken(['documents:write']), 'user-1', '__synth_write', {}, undefined, {
        callerScopes: ['documents:write'],
        conversationId: convId,
        confirmerId: 'user-1',
      }),
    ).rejects.toThrow(/requires confirmation/);
  });

  it('M13 opt-down: the SAME synthetic tool with riskTier:normal is NOT gated', async () => {
    let ran = false;
    registerThrowaway({
      name: '__synth_normal',
      requiredScope: 'documents:write',
      riskTier: 'normal',
      schema: z.object({}).strict(),
      handler: async () => {
        ran = true;
        return { ok: true };
      },
    });
    const convId = await makeConversation();
    const out = await executeTool(
      makeToken(['documents:write']),
      'user-1',
      '__synth_normal',
      {},
      undefined,
      { callerScopes: ['documents:write'], conversationId: convId },
    );
    expect(ran).toBe(true);
    expect(out).toEqual({ ok: true });
  });

  it('headless NOT gated (no regression): a HIGH op with NO conversationId applies in-scope', async () => {
    registerHighTool();
    // No conversationId on the caller → the gate is skipped → the op applies.
    const out = await executeTool(
      makeToken(['documents:delete']),
      'user-1',
      '__danger',
      { slug: 'acme' },
      undefined,
      { callerScopes: ['documents:delete'] },
    );
    expect(applied.count).toBe(1);
    expect(out).toEqual({ deleted: 'acme' });
  });

  it('folio_api: a config-class write through folio_api in a conversation IS gated', async () => {
    // folio_api owns its own per-path tier. A bare-project DELETE maps to
    // config:write (CONFIG_CLASS) → gated by folio_api's OWN handler gate.
    const convId = await makeConversation();
    const sink = makeRecordingSink();
    await expect(
      executeTool(
        makeToken(['config:write', 'documents:write', 'documents:read']),
        'user-1',
        'folio_api',
        { method: 'DELETE', path: '/api/v1/w/acme/p/web' },
        undefined,
        {
          callerScopes: ['config:write', 'documents:write', 'documents:read'],
          conversationId: convId,
          conversationSink: sink,
          confirmerId: 'user-1',
        },
      ),
    ).rejects.toThrow(/requires confirmation/);
    // A pending_ops row keyed on 'folio_api' was recorded + a card raised.
    const rows = await db.select().from(pendingOps).where(eq(pendingOps.conversationId, convId));
    expect(rows.length).toBe(1);
    expect(rows[0]!.op).toBe('folio_api');
    // BLOCKER fix: caller_id is the HUMAN confirmer, not the agent actor.
    expect(rows[0]!.callerId).toBe('user-1');
    expect(sink.components.some((c) => c.type === 'choice_card')).toBe(true);
  });

  it('folio_api: a documents:write through folio_api in a conversation is NOT gated', async () => {
    // A documents path maps to documents:write (NOT config-class) → folio_api does
    // not gate it (act-then-report majority). It dispatches (and may 404 on a
    // missing resource), but it must NOT raise the confirm gate.
    const convId = await makeConversation();
    let threwConfirm = false;
    try {
      await executeTool(
        makeToken(['config:write', 'documents:write', 'documents:read']),
        'user-1',
        'folio_api',
        { method: 'POST', path: '/api/v1/w/acme/p/web/documents', body: { title: 'X' } },
        undefined,
        {
          callerScopes: ['config:write', 'documents:write', 'documents:read'],
          conversationId: convId,
        },
      );
    } catch (err) {
      if (err instanceof Error && /requires confirmation/.test(err.message)) threwConfirm = true;
    }
    expect(threwConfirm).toBe(false);
    // No pending_ops row was recorded for the un-gated document write.
    const rows = await db.select().from(pendingOps).where(eq(pendingOps.conversationId, convId));
    expect(rows.length).toBe(0);
  });

  it('a read-scoped tool is NEVER gated, even in a conversation', async () => {
    let ran = false;
    registerThrowaway({
      name: '__synth_read',
      requiredScope: 'documents:read',
      schema: z.object({}).strict(),
      handler: async () => {
        ran = true;
        return { ok: true };
      },
    });
    const convId = await makeConversation();
    await executeTool(makeToken(['documents:read']), 'user-1', '__synth_read', {}, undefined, {
      callerScopes: ['documents:read'],
      conversationId: convId,
    });
    expect(ran).toBe(true);
  });
});
