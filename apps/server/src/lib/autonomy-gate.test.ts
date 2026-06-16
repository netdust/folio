import { expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { events } from '../db/schema.ts';
import { makeTestApp } from '../test/harness.ts';
import { emitChainSuppressed } from './autonomy-gate.ts';
import { type BusEvent, eventBus } from './event-bus.ts';

// Tier-A security-guard test for lib/autonomy-gate.ts (audit 3.8).
//
// IMPORTANT — what this file actually owns. autonomy-gate.ts does NOT hold the
// allow/deny BRANCH; the header comment is explicit that each of the FIVE call
// sites (trigger-matcher, POST /runs, run_agent MCP, POST /runs/:id/retry,
// retry_run MCP) keeps its OWN `if (agentOriginated && !FOLIO_AGENT_CHAINS_
// ENABLED)` decision + its own transport throw. What is defined exactly ONCE
// here is the SUPPRESSION RECORD — the canonical event the deny branch emits.
//
// So the security contract under test is the audit-trail shape, not a predicate:
// when an agent-originated chain hop is REFUSED (autonomy gate, mitigation 54/51),
// the gate emits EXACTLY ONE durable `agent.chain.suppressed` event whose payload
// is the fixed `{ agent_slug, reason: 'autonomy_gate' }`. The `reason` is the
// security-critical, non-spoofable stamp every call site must converge on — drift
// in this shape is how a suppression silently stops being attributable.

const baseArgs = (seed: Awaited<ReturnType<typeof makeTestApp>>['seed']) => ({
  workspaceId: seed.workspace.id,
  projectId: seed.project.id,
  documentId: 'doc-parent-1',
  agentSlug: 'triage-bot',
  actor: 'agent-token-xyz',
});

test('emits exactly one agent.chain.suppressed row with the canonical reason', async () => {
  const { db, seed } = await makeTestApp();

  await emitChainSuppressed(db, baseArgs(seed));

  const rows = await db.select().from(events).where(eq(events.kind, 'agent.chain.suppressed'));
  // Exactly one — a deny is a single durable record, never zero (silent drop)
  // and never duplicated.
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row.kind).toBe('agent.chain.suppressed');
  // The security-critical, non-spoofable stamp: reason is ALWAYS the literal
  // 'autonomy_gate', and the suppressed agent is attributed by bare slug.
  expect(row.payload).toEqual({ agent_slug: 'triage-bot', reason: 'autonomy_gate' });
  // Suppression is attributed to the originating agent identity, and scoped to
  // the parent's workspace/project/document for the audit trail.
  expect(row.actor).toBe('agent-token-xyz');
  expect(row.workspaceId).toBe(seed.workspace.id);
  expect(row.projectId).toBe(seed.project.id);
});

test('reason is fixed to autonomy_gate and not taken from the agent-supplied slug', async () => {
  // Denial-path adversarial case: an agent could control its own slug. The
  // suppression record must NOT let that slug bleed into / overwrite the
  // `reason` field — reason is the gate's own non-spoofable classification.
  const { db, seed } = await makeTestApp();

  await emitChainSuppressed(db, {
    ...baseArgs(seed),
    agentSlug: 'reason', // a slug that, if confused for the reason key, would mask the stamp
  });

  const rows = await db.select().from(events).where(eq(events.kind, 'agent.chain.suppressed'));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.payload).toEqual({ agent_slug: 'reason', reason: 'autonomy_gate' });
});

test('accepts a null projectId (parent has no project) and still records the deny', async () => {
  // Boundary: ChainSuppressedArgs.projectId is `string | null`. A suppressed hop
  // whose parent has no project must still produce a durable, attributable record.
  const { db, seed } = await makeTestApp();

  await emitChainSuppressed(db, { ...baseArgs(seed), projectId: null });

  const rows = await db.select().from(events).where(eq(events.kind, 'agent.chain.suppressed'));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.projectId).toBeNull();
  expect(rows[0]!.payload).toEqual({ agent_slug: 'triage-bot', reason: 'autonomy_gate' });
});

test('commits in its OWN transaction so the suppression publishes on the live bus', async () => {
  // The emitter wraps emitEvent in txWithEvents — the deferred-publish path.
  // A suppression must reach live SSE subscribers (agents react to it), so the
  // bus publish has to fire AFTER its own commit, not be swallowed. This asserts
  // the un-mocked DB + event-bus chain the emitter is the single owner of.
  const { db, seed } = await makeTestApp();
  const received: BusEvent[] = [];
  const unsub = eventBus.subscribe(seed.workspace.id, undefined, (e) => {
    received.push(e);
  });
  try {
    await emitChainSuppressed(db, baseArgs(seed));
  } finally {
    unsub();
  }

  const suppressed = received.filter((e) => e.kind === 'agent.chain.suppressed');
  expect(suppressed).toHaveLength(1);
  expect(suppressed[0]!.payload).toEqual({ agent_slug: 'triage-bot', reason: 'autonomy_gate' });
});
