/**
 * Phase 3 Sub-phase C.3 — Task C-12: runner-poller tests.
 *
 * Tests the claim-and-dispatch loop (`runPollerOnce`) directly against an
 * in-memory SQLite, with fake `runAgent` / `runAgentResume` injected via
 * `PollerDeps` (NO `mock.module` — it leaks across Bun tests, per
 * [[mock-module-leaks-across-bun-tests]]). Boot recovery is tested by asserting
 * `recoverOrphanRuns` fails a stale `running` row, which is what
 * `startRunnerPoller` fires once on boot.
 *
 * Design notes:
 *  - The concurrency cap is observable only when a dispatch STAYS in flight, so
 *    the cap test injects fakes that return never-settling promises — that way
 *    `inFlight.count` actually reaches the cap within a single `runPollerOnce`.
 *  - A fake that resolves immediately would decrement before the next claim, so
 *    such fakes are used for the "dispatch happened" / "rejection-doesn't-crash"
 *    tests, not the cap test.
 */

import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
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
import { recoverOrphanRuns } from '../services/agent-runs.ts';
import { makeTestApp } from '../test/harness.ts';
import type { AgentRunFrontmatter } from './agent-run-schema.ts';
import { toolsToScopes } from './agent-schema.ts';
import { newApiToken } from './auth.ts';
import { type PollerDeps, runPollerOnce } from './poller.ts';

type TestDB = Awaited<ReturnType<typeof makeTestApp>>['db'];

// --- seeding helpers (mirrors services/agent-runs.test.ts) -----------------

async function seedRunsTable(db: TestDB, projectId: string): Promise<TableEntity> {
  const id = nanoid();
  await db.insert(tables).values({ id, projectId, slug: 'runs', name: 'Runs' });
  const t = await db.query.tables.findFirst({ where: eq(tables.id, id) });
  return t!;
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
  return row!;
}

async function seedAgent(
  db: TestDB,
  workspace: Workspace,
  user: User,
  slug: string,
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
    body: '',
    frontmatter: {
      system_prompt: 'You are a helper.',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      tools: ['list_documents'],
      projects: ['*'],
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
  return row!;
}

/**
 * Seed an agent_run row directly at status='planning' (what createRun produces
 * + what claimNextPlanningRun consumes). `overrides` lets a test set
 * `resume_of` for the resume-dispatch test.
 */
async function seedPlanningRun(
  db: TestDB,
  workspace: Workspace,
  project: Project,
  runsTable: TableEntity,
  agent: Document,
  parent: Document,
  user: User,
  overrides: Partial<AgentRunFrontmatter> = {},
): Promise<Document> {
  const id = nanoid();
  const now = new Date().toISOString();
  const fm: AgentRunFrontmatter = {
    assignee: `agent:${agent.slug}`,
    status: 'planning',
    agent_slug: agent.slug,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    system_prompt: 'You are a helper.',
    max_tokens: 12_345,
    tokens_in: 0,
    tokens_out: 0,
    trigger_id: null,
    chain_id: crypto.randomUUID(),
    fired_by: 'agent.task.assigned',
    started_at: now,
    caller_scopes: [],
    caller_project_ids: null,
    ...overrides,
  };
  await db.insert(documents).values({
    id,
    workspaceId: workspace.id,
    projectId: project.id,
    tableId: runsTable.id,
    type: 'agent_run',
    slug: `${agent.slug}-${now.replace(/:/g, '-')}-${nanoid(8)}`,
    title: `${agent.slug} run`,
    status: fm.status,
    body: '',
    frontmatter: fm as unknown as Record<string, unknown>,
    parentId: parent.id,
    createdBy: user.id,
    updatedBy: user.id,
  });
  const row = await db.query.documents.findFirst({ where: eq(documents.id, id) });
  return row!;
}

/** A stale `running` row whose worker_started_at is older than any threshold. */
async function seedStaleRunningRun(
  db: TestDB,
  workspace: Workspace,
  project: Project,
  runsTable: TableEntity,
  agent: Document,
  parent: Document,
  user: User,
): Promise<Document> {
  const id = nanoid();
  const now = new Date().toISOString();
  const ancient = new Date(Date.now() - 60 * 60_000).toISOString(); // 1h ago
  const fm: AgentRunFrontmatter = {
    assignee: `agent:${agent.slug}`,
    status: 'running',
    agent_slug: agent.slug,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    system_prompt: 'You are a helper.',
    max_tokens: 12_345,
    tokens_in: 0,
    tokens_out: 0,
    trigger_id: null,
    chain_id: crypto.randomUUID(),
    fired_by: 'agent.task.assigned',
    started_at: ancient,
    worker_started_at: ancient,
    caller_scopes: [],
    caller_project_ids: null,
  };
  await db.insert(documents).values({
    id,
    workspaceId: workspace.id,
    projectId: project.id,
    tableId: runsTable.id,
    type: 'agent_run',
    slug: `${agent.slug}-${now.replace(/:/g, '-')}-${nanoid(8)}`,
    title: `${agent.slug} run`,
    status: fm.status,
    body: '',
    frontmatter: fm as unknown as Record<string, unknown>,
    parentId: parent.id,
    createdBy: user.id,
    updatedBy: user.id,
  });
  const row = await db.query.documents.findFirst({ where: eq(documents.id, id) });
  return row!;
}

// --- dep fakes -------------------------------------------------------------

/** A dep whose dispatches resolve immediately and record the run ids called. */
function recordingDeps(maxConcurrent: number): PollerDeps & {
  runAgentCalls: string[];
  runAgentResumeCalls: string[];
} {
  const runAgentCalls: string[] = [];
  const runAgentResumeCalls: string[] = [];
  return {
    runAgentCalls,
    runAgentResumeCalls,
    maxConcurrent,
    inFlight: { count: 0 },
    runAgent: async ({ runId }) => {
      runAgentCalls.push(runId);
    },
    runAgentResume: async ({ runId }) => {
      runAgentResumeCalls.push(runId);
    },
  };
}

/**
 * A dep whose dispatches NEVER settle, so `inFlight.count` stays elevated for
 * the whole `runPollerOnce` call — letting the cap actually bind. Records the
 * run ids it was asked to dispatch.
 */
function pendingDeps(maxConcurrent: number): PollerDeps & { calls: string[] } {
  const calls: string[] = [];
  const neverSettles = ({ runId }: { runId: string }): Promise<void> => {
    calls.push(runId);
    return new Promise<void>(() => {
      /* intentionally never resolves */
    });
  };
  return {
    calls,
    maxConcurrent,
    inFlight: { count: 0 },
    runAgent: neverSettles,
    runAgentResume: neverSettles,
  };
}

// --- tests -----------------------------------------------------------------

describe('runner poller', () => {
  test('recoverOrphanRuns (boot recovery) fails a stale running row', async () => {
    const { db, seed } = await makeTestApp();
    const table = await db.query.tables.findFirst({
      where: and(eq(tables.projectId, seed.project.id), eq(tables.slug, 'work-items')),
    });
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table!, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);
    const stale = await seedStaleRunningRun(
      db,
      seed.workspace,
      seed.project,
      runsTable,
      agent,
      parent,
      seed.user,
    );

    const recovered = await recoverOrphanRuns({ staleThresholdMs: 300_000 });

    expect(recovered).toContain(stale.id);
    const row = await db.query.documents.findFirst({ where: eq(documents.id, stale.id) });
    expect(row!.status).toBe('failed');
    expect((row!.frontmatter as AgentRunFrontmatter).error_reason).toBe('worker_crash');
  });

  test('claims a planning row and dispatches runAgent', async () => {
    const { db, seed } = await makeTestApp();
    const table = await db.query.tables.findFirst({
      where: and(eq(tables.projectId, seed.project.id), eq(tables.slug, 'work-items')),
    });
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table!, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);
    const run = await seedPlanningRun(
      db,
      seed.workspace,
      seed.project,
      runsTable,
      agent,
      parent,
      seed.user,
    );

    const deps = recordingDeps(5);
    await runPollerOnce(db, deps);
    // Let the fire-and-forget dispatch microtasks settle.
    await Promise.resolve();

    expect(deps.runAgentCalls).toEqual([run.id]);
    expect(deps.runAgentResumeCalls).toEqual([]);
    // The claim flipped it to running.
    const row = await db.query.documents.findFirst({ where: eq(documents.id, run.id) });
    expect(row!.status).toBe('running');
  });

  test('dispatches runAgentResume when the claimed row has frontmatter.resume_of', async () => {
    const { db, seed } = await makeTestApp();
    const table = await db.query.tables.findFirst({
      where: and(eq(tables.projectId, seed.project.id), eq(tables.slug, 'work-items')),
    });
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table!, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);
    const run = await seedPlanningRun(
      db,
      seed.workspace,
      seed.project,
      runsTable,
      agent,
      parent,
      seed.user,
      { resume_of: nanoid() },
    );

    const deps = recordingDeps(5);
    await runPollerOnce(db, deps);
    await Promise.resolve();

    expect(deps.runAgentResumeCalls).toEqual([run.id]);
    expect(deps.runAgentCalls).toEqual([]);
  });

  test('respects the concurrency cap (never more than N in-flight)', async () => {
    const { db, seed } = await makeTestApp();
    const table = await db.query.tables.findFirst({
      where: and(eq(tables.projectId, seed.project.id), eq(tables.slug, 'work-items')),
    });
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table!, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    const cap = 3;
    // Seed cap + 2 planning rows; each is a distinct parent so getActiveRun
    // idempotency would never apply (the poller doesn't preflight anyway).
    for (let i = 0; i < cap + 2; i++) {
      const p = await seedWorkItem(db, seed.workspace, seed.project, table!, seed.user);
      await seedPlanningRun(db, seed.workspace, seed.project, runsTable, agent, p, seed.user);
    }
    void parent; // first parent unused — distinct parents seeded in the loop

    const deps = pendingDeps(cap);
    await runPollerOnce(db, deps);

    // Only `cap` dispatched this tick; the rest stay planning for the next tick.
    expect(deps.calls.length).toBe(cap);
    expect(deps.inFlight.count).toBe(cap);

    const planning = await db.query.documents.findMany({
      where: and(eq(documents.type, 'agent_run'), eq(documents.status, 'planning')),
    });
    expect(planning.length).toBe(2);
  });

  test('a runAgent rejection does not crash the loop', async () => {
    const { db, seed } = await makeTestApp();
    const table = await db.query.tables.findFirst({
      where: and(eq(tables.projectId, seed.project.id), eq(tables.slug, 'work-items')),
    });
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const runsTable = await seedRunsTable(db, seed.project.id);

    const p1 = await seedWorkItem(db, seed.workspace, seed.project, table!, seed.user);
    const run1 = await seedPlanningRun(
      db,
      seed.workspace,
      seed.project,
      runsTable,
      agent,
      p1,
      seed.user,
    );

    let calls = 0;
    const deps: PollerDeps = {
      maxConcurrent: 5,
      inFlight: { count: 0 },
      runAgent: async () => {
        calls++;
        throw new Error('boom');
      },
      runAgentResume: async () => {},
    };

    // First tick: dispatch rejects, runPollerOnce must still RESOLVE.
    await expect(runPollerOnce(db, deps)).resolves.toBeUndefined();
    await Promise.resolve();
    expect(calls).toBe(1);
    void run1;

    // Seed a second planning row; the next tick still claims + dispatches it,
    // proving the loop wasn't crashed by the prior rejection.
    const p2 = await seedWorkItem(db, seed.workspace, seed.project, table!, seed.user);
    await seedPlanningRun(db, seed.workspace, seed.project, runsTable, agent, p2, seed.user);
    await runPollerOnce(db, deps);
    await Promise.resolve();
    expect(calls).toBe(2);
  });
});
