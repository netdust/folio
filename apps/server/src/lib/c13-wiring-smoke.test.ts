/**
 * C-13 WIRING SMOKE (Sub-phase D STOP-gate 1, headless).
 *
 * The C-13 plan calls for a manual dev-server smoke proving the Reaction Plane
 * composes end-to-end: assign a work_item to an agent → `agent.task.assigned`
 * lands in the durable events table → the dispatcher fans it to the
 * trigger-matcher reactor → the matcher matches `builtin-on-assignment` + the
 * allow-list + the autonomy gate → a `planning` agent_run row is durably
 * created → the poller claims it ~1 tick later → `runAgent` is dispatched.
 *
 * Stefan is on remote-control (no browser), so this is the headless equivalent:
 * it drives the REAL `runDispatcherOnce(db, REACTORS)` + `runPollerOnce(db, deps)`
 * (the same functions index.ts wires on boot), with ONLY the provider stubbed
 * (a fake `runAgent` — no key, no credits burned). It proves the WIRING, which
 * is exactly what C-13 is for; real provider streaming is D-3's job.
 *
 * Three smokes, mirroring the C-13 manual checklist:
 *  1. Happy path: assignment → dispatcher → planning row → poller claims → runAgent.
 *  2. Autonomy gate: agent-ORIGINATED assignment with FOLIO_AGENT_CHAINS_ENABLED
 *     off → ZERO runs + one agent.chain.suppressed; flag on → one run.
 *  3. Reactor halt: a reactor that throws → reactor.halted on the bus, cursor
 *     does not advance; recovery → reactor.recovered.
 *
 * If any of these fail, it's a C.3 wiring bug to fix BEFORE Sub-phase D — the
 * unit gates that closed C.3 didn't exercise the composed loop.
 *
 * BOOT-ORDER NOTE (matches production): on first registration a reactor's cursor
 * SEEDS AT MAX(seq) (`loadOrSeedCursor` in event-dispatcher.ts) — a reactor only
 * processes events emitted AFTER it starts, it does NOT replay history. So each
 * smoke runs ONE priming dispatcher tick (seeds the cursor) BEFORE emitting the
 * assignment, exactly as index.ts starts the dispatcher before live traffic.
 */

import { afterEach, expect, test } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  type Document,
  type Project,
  type TableEntity,
  type User,
  type Workspace,
  apiTokens,
  documents,
  tables,
} from '../db/schema.ts';
import { env } from '../env.ts';
import { makeTestApp } from '../test/harness.ts';
import type { TestSeed } from '../test/harness.ts';
import { toolsToScopes } from './agent-schema.ts';
import { newApiToken } from './auth.ts';
import { seedBuiltinTriggers } from './builtin-triggers.ts';
import { emitEvent } from './events.ts';
import { eventBus } from './event-bus.ts';
import type { BusEvent } from './event-bus.ts';
import { runDispatcherOnce, type Reactor } from './event-dispatcher.ts';
import { REACTORS } from './reactors.ts';
import { runPollerOnce, type PollerDeps } from './poller.ts';

type TestDB = Awaited<ReturnType<typeof makeTestApp>>['db'];

afterEach(() => eventBus.__clear());

// ----- seed helpers (mirrored from trigger-matcher.test.ts / agent-runs.test.ts) -----

async function getWorkItemsTable(db: TestDB, projectId: string): Promise<TableEntity> {
  const t = await db.query.tables.findFirst({
    where: and(eq(tables.projectId, projectId), eq(tables.slug, 'work-items')),
  });
  if (!t) throw new Error('smoke setup: work-items table missing');
  return t;
}

async function seedWorkItem(
  db: TestDB,
  workspace: Workspace,
  project: Project,
  table: TableEntity,
  user: User,
): Promise<Document> {
  const id = nanoid();
  await db.insert(documents).values({
    id,
    workspaceId: workspace.id,
    projectId: project.id,
    tableId: table.id,
    type: 'work_item',
    slug: `wi-${nanoid(6)}`,
    title: 'Parent WI',
    status: null,
    body: '',
    frontmatter: {},
    createdBy: user.id,
    updatedBy: user.id,
  });
  const row = await db.query.documents.findFirst({ where: eq(documents.id, id) });
  if (!row) throw new Error('smoke setup: work_item did not round-trip');
  return row;
}

async function seedAgent(
  db: TestDB,
  workspace: Workspace,
  user: User,
  slug: string,
  projectsAllowList: string[] = ['*'],
): Promise<Document> {
  const id = nanoid();
  const { hash } = newApiToken();
  const apiTokenId = nanoid();
  await db.insert(documents).values({
    id,
    workspaceId: workspace.id,
    projectId: null,
    tableId: null,
    type: 'agent',
    slug,
    title: slug,
    status: null,
    // The agent body IS the prompt (snapshot at run-create); createRun rejects
    // an empty body, so seed a non-empty one.
    body: 'You are a helper.',
    frontmatter: {
      system_prompt: 'You are a helper.',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      tools: ['list_documents'],
      projects: projectsAllowList,
      max_delegation_depth: 2,
      max_tokens_per_run: 12_345,
      requires_approval: false,
      api_token_id: apiTokenId,
    },
    createdBy: user.id,
    updatedBy: user.id,
  });
  await db.insert(apiTokens).values({
    id: apiTokenId,
    workspaceId: workspace.id,
    name: `agent:${slug}`,
    tokenHash: hash,
    scopes: toolsToScopes(['list_documents']),
    agentId: id,
    createdBy: user.id,
  });
  const row = await db.query.documents.findFirst({ where: eq(documents.id, id) });
  if (!row) throw new Error('smoke setup: agent did not round-trip');
  return row;
}

async function seedTriggers(db: TestDB, workspaceId: string, actorId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await seedBuiltinTriggers(tx, workspaceId, actorId);
  });
}

/** Emit a real durable `agent.task.assigned` row so the dispatcher will see it. */
async function emitAssignment(
  db: TestDB,
  seed: TestSeed,
  workItem: Document,
  agent: Document,
  actor: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await emitEvent(tx, {
      workspaceId: seed.workspace.id,
      projectId: seed.project.id,
      documentId: workItem.id, // assignment: documentId IS the parent work_item
      kind: 'agent.task.assigned',
      actor,
      payload: { slug: workItem.slug, agent: agent.slug, agent_id: agent.id },
    });
  });
}

async function planningRunCount(db: TestDB, parentId: string, agentSlug: string): Promise<number> {
  const rows = await db.query.documents.findMany({
    where: and(
      eq(documents.type, 'agent_run'),
      eq(documents.parentId, parentId),
      sql`json_extract(${documents.frontmatter}, '$.agent_slug') = ${agentSlug}`,
    ),
  });
  return rows.length;
}

function makePollerDeps(captured: { runAgent: string[]; runAgentResume: string[] }): PollerDeps {
  return {
    // Stubbed provider entry points — NO real stream, NO key, NO credits.
    runAgent: async ({ runId }) => {
      captured.runAgent.push(runId);
    },
    runAgentResume: async ({ runId }) => {
      captured.runAgentResume.push(runId);
    },
    maxConcurrent: 5,
    inFlight: { count: 0 },
  };
}

// ===== Smoke 1: happy-path wiring =====

test('SMOKE 1: assignment → dispatcher → planning run → poller claims → runAgent', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
  const workItem = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  await seedTriggers(db, seed.workspace.id, seed.user.id);

  // 0) Prime the dispatcher: first tick seeds the matcher's cursor at MAX(seq)
  //    (production boot order — the dispatcher starts before live traffic).
  await runDispatcherOnce(db, REACTORS);

  // 1) A human assigns the work item to the agent — durable event row.
  await emitAssignment(db, seed, workItem, agent, /* actor = human */ seed.user.id);

  // 2) The dispatcher fans the event to the trigger-matcher reactor (REAL loop).
  await runDispatcherOnce(db, REACTORS);

  // 3) The matcher should have durably created exactly one planning run.
  expect(await planningRunCount(db, workItem.id, agent.slug)).toBe(1);
  const planningRow = await db.query.documents.findFirst({
    where: and(eq(documents.type, 'agent_run'), eq(documents.parentId, workItem.id)),
  });
  expect(planningRow?.status).toBe('planning');

  // 4) The poller claims it and dispatches runAgent (stubbed — no provider call).
  const captured = { runAgent: [] as string[], runAgentResume: [] as string[] };
  await runPollerOnce(db, makePollerDeps(captured));
  // Let the fire-and-forget dispatch microtask settle (poller pattern).
  await Promise.resolve();

  // 5) Assert the FULL chain fired: claimed → runAgent invoked with the run id,
  //    runAgentResume NOT invoked (fresh run, no resume_of), and the row is now
  //    claimed (running).
  expect(captured.runAgent).toEqual([planningRow!.id]);
  expect(captured.runAgentResume).toEqual([]);
  const claimedRow = await db.query.documents.findFirst({
    where: eq(documents.id, planningRow!.id),
  });
  expect(claimedRow?.status).toBe('running');
});

// ===== Smoke 2: autonomy gate (mitigation 51) =====

test('SMOKE 2: autonomy gate — agent-originated assignment is suppressed; human assignment fires', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
  const peerAgent = await seedAgent(db, seed.workspace, seed.user, 'peer');
  const agentParent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const humanParent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  await seedTriggers(db, seed.workspace.id, seed.user.id);

  // Capture system-bus events so we can assert agent.chain.suppressed fires.
  const busKinds: string[] = [];
  const unsub = eventBus.subscribe(seed.workspace.id, {}, (e: BusEvent) => busKinds.push(e.kind));

  const flagWas = env.FOLIO_AGENT_CHAINS_ENABLED;
  try {
    // Prime the matcher's cursor at MAX(seq) before any assignment (boot order).
    await runDispatcherOnce(db, REACTORS);

    // Flag OFF (the V1 default). Two assignments fan through ONE dispatcher tick:
    //  - AGENT-originated (actor = agent:<slug>) → suppressed (mitigation 51):
    //    ZERO runs + one agent.chain.suppressed.
    //  - HUMAN-originated (actor = the seeded user) → fires one run (the gate
    //    must not over-block human-initiated work — the V1-allowed path).
    (env as { FOLIO_AGENT_CHAINS_ENABLED: boolean }).FOLIO_AGENT_CHAINS_ENABLED = false;
    await emitAssignment(db, seed, agentParent, agent, /* actor = agent */ `agent:${peerAgent.slug}`);
    await emitAssignment(db, seed, humanParent, agent, /* actor = human */ seed.user.id);
    await runDispatcherOnce(db, REACTORS);

    // Agent-originated: suppressed.
    expect(await planningRunCount(db, agentParent.id, agent.slug)).toBe(0);
    expect(busKinds).toContain('agent.chain.suppressed');
    // Human-originated: fires (owner resolves to the seeded user).
    expect(await planningRunCount(db, humanParent.id, agent.slug)).toBe(1);
  } finally {
    (env as { FOLIO_AGENT_CHAINS_ENABLED: boolean }).FOLIO_AGENT_CHAINS_ENABLED = flagWas;
    unsub();
    // Unsubscribe + drain so no async bus emit lands on the next test's DB.
    await Promise.resolve();
  }
});

// ===== Smoke 3: reactor halt + recover (mitigation 49/53) =====

test('SMOKE 3: a throwing reactor halts (cursor frozen) then recovers', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
  const workItem = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  await seedTriggers(db, seed.workspace.id, seed.user.id);

  const busKinds: string[] = [];
  const unsub = eventBus.subscribe(seed.workspace.id, {}, (e: BusEvent) => busKinds.push(e.kind));

  // A reactor that throws on the first event it sees, then (after we flip the
  // flag) succeeds — proving halt → cursor-frozen → recovered.
  let shouldThrow = true;
  const flaky: Reactor = {
    id: 'smoke-flaky-reactor',
    kinds: ['agent.task.assigned'],
    async react() {
      if (shouldThrow) throw new Error('synthetic reactor failure');
    },
  };

  try {
    // Prime the flaky reactor's cursor at MAX(seq) before the assignment.
    await runDispatcherOnce(db, [flaky]);

    await emitAssignment(db, seed, workItem, agent, seed.user.id);

    // Tick 1: the flaky reactor throws → halt + reactor.halted on the bus.
    await runDispatcherOnce(db, [flaky]);
    expect(busKinds).toContain('reactor.halted');

    // Tick 2 (still throwing): cursor stayed frozen, so it RE-enters the same
    // event and halts again — no progress. (At-least-once: cursor advances only
    // on success.) We assert no reactor.recovered yet.
    busKinds.length = 0;
    await runDispatcherOnce(db, [flaky]);
    expect(busKinds).not.toContain('reactor.recovered');

    // Flip to success → cursor advances, recovered fires.
    shouldThrow = false;
    busKinds.length = 0;
    await runDispatcherOnce(db, [flaky]);
    expect(busKinds).toContain('reactor.recovered');
  } finally {
    unsub();
    await Promise.resolve();
  }
});
