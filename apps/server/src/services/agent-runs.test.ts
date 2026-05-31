/**
 * Service-level tests for the agent-runs service (Phase 3 Sub-phase C.1).
 *
 * Bypasses HTTP; calls the service functions directly against an in-memory
 * SQLite via the standard test harness.
 */

import { test, expect, describe } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { makeTestApp } from '../test/harness.ts';
import {
  apiTokens,
  documents,
  events,
  projects as schemaProjects,
  tables,
  users,
  workspaces,
  type Document,
  type Project,
  type TableEntity,
  type User,
  type Workspace,
} from '../db/schema.ts';
import { seedProjectDefaults } from '../lib/seed-project-defaults.ts';
import { newApiToken } from '../lib/auth.ts';
import { toolsToScopes } from '../lib/agent-schema.ts';
import type { AgentRunFrontmatter } from '../lib/agent-run-schema.ts';
import { HTTPError } from '../lib/http.ts';
import { sanitizeProviderError } from '../lib/ai/sanitize-error.ts';
import {
  createRun,
  transitionRun,
  incrementTokens,
  setRunBody,
  getActiveRun,
  getPendingApprovalRun,
  listRuns,
  claimNextPlanningRun,
  recoverOrphanRuns,
  countPendingPlanning,
  checkRunRateLimits,
  checkChainGuards,
  checkProviderHealth,
  getProviderHealth,
  ensureRunsTable,
  nextChainId,
} from './agent-runs.ts';
import { statuses, views } from '../db/schema.ts';
import { agentRunFrontmatterSchema } from '../lib/agent-run-schema.ts';

type TestDB = Awaited<ReturnType<typeof makeTestApp>>['db'];

async function getWorkItemsTable(db: TestDB, projectId: string): Promise<TableEntity> {
  const t = await db.query.tables.findFirst({
    where: and(eq(tables.projectId, projectId), eq(tables.slug, 'work-items')),
  });
  if (!t) throw new Error('test setup: work-items table missing');
  return t;
}

/**
 * Stand-in for C-6's ensureRunsTable. Inserts a minimal `runs` table for the
 * project so agent_run rows can satisfy the CHECK constraint. Real lazy-seed
 * lands in Task C-6 with statuses + views; for C-1 we only need a row in
 * `tables` so the FK + CHECK are satisfied.
 */
async function seedRunsTable(db: TestDB, projectId: string): Promise<TableEntity> {
  const id = nanoid();
  await db.insert(tables).values({
    id,
    projectId,
    slug: 'runs',
    name: 'Runs',
  });
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
  body = 'You are a helper.',
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
    body,
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

async function seedRunningRun(
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
    started_at: now,
    worker_started_at: now,
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

// ---------- createRun ----------

describe('createRun', () => {
  test('inserts an agent_run document at status=planning and emits agent.run.started', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);

    const runsTable = await seedRunsTable(db, seed.project.id);
    const result = await createRun({
      workspace: seed.workspace,
      project: seed.project,
      runsTable,
      agent,
      actor: seed.user,
      input: {
        parentDocumentId: parent.id,
        firedBy: 'agent.task.assigned',
        chainId: crypto.randomUUID(),
        triggerId: null,
      },
    });

    expect(result.document.type).toBe('agent_run');
    const fm = result.document.frontmatter as AgentRunFrontmatter;
    expect(fm.status).toBe('planning');
    expect(fm.agent_slug).toBe(agent.slug);
    expect(fm.provider).toBe('anthropic');
    expect(fm.model).toBe('claude-sonnet-4-6');
    expect(fm.system_prompt).toBe('You are a helper.');
    expect(fm.max_tokens).toBe(12_345);
    expect(fm.tokens_in).toBe(0);
    expect(fm.tokens_out).toBe(0);
    expect(fm.assignee).toBe(`agent:${agent.slug}`);
    expect(fm.fired_by).toBe('agent.task.assigned');
    expect(fm.trigger_id).toBe(null);

    // documents.status column mirrors frontmatter.status (mitigation 40 setup).
    expect(result.document.status).toBe('planning');

    // Slug shape: starts with agent slug, includes an ISO-stripped timestamp,
    // ends in 8 chars of nanoid suffix (no colons anywhere — filesystem-safe).
    expect(result.document.slug.startsWith(`${agent.slug}-`)).toBe(true);
    expect(result.document.slug.includes(':')).toBe(false);
    expect(result.document.slug.length).toBeGreaterThan(agent.slug.length + 8);

    // Workspace + project scope (mitigation 23 — inherited from createDocument
    // contract; agent_run is project-scoped, parent is in the project).
    expect(result.document.workspaceId).toBe(seed.workspace.id);
    expect(result.document.projectId).toBe(seed.project.id);
    expect(result.document.parentId).toBe(parent.id);

    const runStartedEvents = await db.query.events.findMany({
      where: eq(events.kind, 'agent.run.started'),
    });
    expect(runStartedEvents.length).toBe(1);
    expect(runStartedEvents[0]!.documentId).toBe(result.document.id);
    expect(runStartedEvents[0]!.workspaceId).toBe(seed.workspace.id);
    expect(runStartedEvents[0]!.projectId).toBe(seed.project.id);
  });

  test('snapshots the agent BODY as the run system prompt (not frontmatter.system_prompt)', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    // Body differs from frontmatter.system_prompt so the assertion proves the
    // snapshot source is the body, not the frontmatter field.
    const agent = await seedAgent(
      db,
      seed.workspace,
      seed.user,
      'bodyprompt',
      'You are the body prompt.',
    );
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    const result = await createRun({
      workspace: seed.workspace,
      project: seed.project,
      runsTable,
      agent,
      actor: seed.user,
      input: {
        parentDocumentId: parent.id,
        firedBy: 'agent.task.assigned',
        chainId: crypto.randomUUID(),
        triggerId: null,
      },
    });

    const fm = result.document.frontmatter as AgentRunFrontmatter;
    expect(fm.system_prompt).toBe('You are the body prompt.');
  });

  test('rejects an agent whose body (the prompt) is empty', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    // Whitespace-only body → trim() → '' → the empty-prompt guard must fire.
    const agent = await seedAgent(db, seed.workspace, seed.user, 'whitespace-agent', '   ');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    await expect(
      createRun({
        workspace: seed.workspace,
        project: seed.project,
        runsTable,
        agent,
        actor: seed.user,
        input: {
          parentDocumentId: parent.id,
          firedBy: 'agent.task.assigned',
          chainId: crypto.randomUUID(),
          triggerId: null,
        },
      }),
    ).rejects.toThrow(/empty|prompt/i);
  });
});

// ---------- transitionRun ----------

describe('transitionRun', () => {
  test('transitions planning → running and emits agent.run.running', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);

    const runsTable = await seedRunsTable(db, seed.project.id);
    const created = await createRun({
      workspace: seed.workspace,
      project: seed.project,
      runsTable,
      agent,
      actor: seed.user,
      input: {
        parentDocumentId: parent.id,
        firedBy: 'agent.task.assigned',
        chainId: crypto.randomUUID(),
        triggerId: null,
      },
    });

    await transitionRun(created.document.id, { newStatus: 'running', actor: seed.user.id });

    const row = await db.query.documents.findFirst({
      where: eq(documents.id, created.document.id),
    });
    expect(row!.status).toBe('running');
    expect((row!.frontmatter as AgentRunFrontmatter).status).toBe('running');

    const runningEvents = await db.query.events.findMany({
      where: eq(events.kind, 'agent.run.running'),
    });
    expect(runningEvents.length).toBe(1);
    expect(runningEvents[0]!.documentId).toBe(created.document.id);
  });

  test('throws INVALID_RUN_TRANSITION on illegal moves', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);

    const runsTable = await seedRunsTable(db, seed.project.id);
    const created = await createRun({
      workspace: seed.workspace,
      project: seed.project,
      runsTable,
      agent,
      actor: seed.user,
      input: {
        parentDocumentId: parent.id,
        firedBy: 'agent.task.assigned',
        chainId: crypto.randomUUID(),
        triggerId: null,
      },
    });

    // planning → completed is illegal (must pass through running first).
    let caught: HTTPError | null = null;
    try {
      await transitionRun(created.document.id, { newStatus: 'completed', actor: seed.user.id });
    } catch (e) {
      caught = e as HTTPError;
    }
    expect(caught).toBeInstanceOf(HTTPError);
    expect(caught!.status).toBe(409);
    expect(caught!.code).toBe('INVALID_RUN_TRANSITION');
    // from + to must be carried as additional properties for callers that
    // catch + branch on them (loser-no-op pattern in approval races).
    expect((caught as unknown as { from: string }).from).toBe('planning');
    expect((caught as unknown as { to: string }).to).toBe('completed');
  });

  test('throws AGENT_RUN_NOT_FOUND when the row does not exist', async () => {
    const { db, seed } = await makeTestApp();
    let caught: HTTPError | null = null;
    try {
      await transitionRun(nanoid(), { newStatus: 'running', actor: seed.user.id });
    } catch (e) {
      caught = e as HTTPError;
    }
    expect(caught).toBeInstanceOf(HTTPError);
    expect(caught!.status).toBe(404);
    expect(caught!.code).toBe('AGENT_RUN_NOT_FOUND');
  });

  test('clears worker_started_at atomically on terminal status (one observable read)', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);
    const run = await seedRunningRun(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user);

    // Pre-condition: worker_started_at is set.
    expect((run.frontmatter as AgentRunFrontmatter).worker_started_at).toBeTruthy();

    await transitionRun(run.id, { newStatus: 'completed', actor: seed.user.id });

    // Read in a fresh query — both status flip + worker_started_at clear must be
    // visible in a single read (mitigation 40 — one UPDATE, no intermediate
    // state observable). Re-running the same JSON path query checks both.
    const after = await db.query.documents.findFirst({ where: eq(documents.id, run.id) });
    const fm = after!.frontmatter as AgentRunFrontmatter;
    expect(after!.status).toBe('completed');
    expect(fm.status).toBe('completed');
    expect(fm.worker_started_at).toBeFalsy();
    expect(fm.completed_at).toBeTruthy();
  });

  test('rejects unknown error_reason via Zod', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);
    const run = await seedRunningRun(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user);

    await expect(
      transitionRun(run.id, {
        newStatus: 'failed',
        actor: seed.user.id,
        errorReason: 'made_up_reason' as never,
      }),
    ).rejects.toThrow();
  });

  test('runs error_detail through sanitizeProviderError (no raw SDK echo)', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);
    const run = await seedRunningRun(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user);

    const hostileDetail = 'apiKey:sk-abc123 baseUrl:https://attacker.example';
    await transitionRun(run.id, {
      newStatus: 'failed',
      actor: seed.user.id,
      errorReason: 'provider_error',
      errorDetail: hostileDetail,
    });

    const after = await db.query.documents.findFirst({ where: eq(documents.id, run.id) });
    const fm = after!.frontmatter as AgentRunFrontmatter;
    expect(fm.error_reason).toBe('provider_error');
    // sanitizeProviderError is whitelist-based: it ignores the input err's
    // string body and returns a fixed message from the HTTP status (or
    // 'Network error or unreachable host.' when no status). The original
    // attacker-controlled fragments MUST NOT survive into error_detail.
    expect(fm.error_detail).toBeTruthy();
    expect(fm.error_detail).not.toContain('sk-abc123');
    expect(fm.error_detail).not.toContain('attacker.example');
    expect(fm.error_detail).not.toContain('apiKey');
    expect(fm.error_detail).not.toContain('baseUrl');
  });

  test('writes documents.status column and frontmatter.status in lockstep', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);
    const run = await seedRunningRun(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user);

    await transitionRun(run.id, { newStatus: 'failed', actor: seed.user.id, errorReason: 'worker_crash' });

    const after = await db.query.documents.findFirst({ where: eq(documents.id, run.id) });
    expect(after!.status).toBe('failed');
    expect((after!.frontmatter as AgentRunFrontmatter).status).toBe('failed');
  });

  test('does not materialize done_reason:null when transitioning to a non-completion terminal state', async () => {
    // Regression — FIX #4 (commit 1486296) folded done_reason into
    // transitionRun's json_set via a self-assign preserve-branch:
    //   json_set(fm, '$.done_reason', json_extract(fm, '$.done_reason'))
    // On a row WITHOUT done_reason (every failed/rejected path: no_ai_key,
    // budget, chain_guard, tool_error, awaiting_approval rejection) this
    // MATERIALIZES `done_reason: null` — schema-INVALID against
    // agentRunFrontmatterSchema (done_reason is .optional(), NOT
    // .nullable(), under .strict()). The key must be ABSENT, not null.
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);
    const created = await createRun({
      workspace: seed.workspace,
      project: seed.project,
      runsTable,
      agent,
      actor: seed.user,
      input: {
        parentDocumentId: parent.id,
        firedBy: 'agent.task.assigned',
        chainId: crypto.randomUUID(),
        triggerId: null,
      },
    });

    // planning → running → failed, with NO doneReason on any hop.
    await transitionRun(created.document.id, { newStatus: 'running', actor: seed.user.id });
    await transitionRun(created.document.id, {
      newStatus: 'failed',
      actor: seed.user.id,
      errorReason: 'worker_crash',
    });

    const after = await db.query.documents.findFirst({ where: eq(documents.id, created.document.id) });
    const fm = after!.frontmatter as Record<string, unknown>;

    // The key must be ABSENT — not present-with-null. `'in'` distinguishes
    // the two; the buggy code leaves `done_reason: null` IN the object.
    expect('done_reason' in fm).toBe(false);
    expect(fm.done_reason).toBeUndefined();

    // And done_reason must round-trip the strict OPTIONAL (non-nullable)
    // schema field. With done_reason:null present, this rejects — which is
    // the corruption FIX #4 introduced. (Scoped to done_reason: a full
    // agentRunFrontmatterSchema.safeParse still fails here on the
    // pre-existing error_reason/error_detail/worker_started_at `?? null`
    // materializations, which are out of scope for this fix.)
    const parsed = agentRunFrontmatterSchema.shape.done_reason.safeParse(fm.done_reason);
    expect(parsed.success).toBe(true);
  });

  test('writes done_reason atomically on a completed transition when supplied', async () => {
    // Companion guarantee — the completed path MUST still write done_reason
    // in the same UPDATE as the status flip (unchanged behavior).
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);
    const run = await seedRunningRun(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user);

    await transitionRun(run.id, { newStatus: 'completed', actor: seed.user.id, doneReason: 'refusal' });

    const after = await db.query.documents.findFirst({ where: eq(documents.id, run.id) });
    const fm = after!.frontmatter as AgentRunFrontmatter;
    expect(fm.status).toBe('completed');
    expect(fm.done_reason).toBe('refusal');
    expect(agentRunFrontmatterSchema.shape.done_reason.safeParse(fm.done_reason).success).toBe(true);
  });

  test('writes the supplied actor to documents.updatedBy and the emitted event', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);
    const run = await seedRunningRun(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user);

    // A distinct actor (e.g. approver, admin force-fail) advances the run —
    // must be recorded on the row AND the event, not the row's prior updatedBy.
    // documents.updated_by has an FK to users.id, so the actor must be a real
    // user id. (System-actor variants like a polling worker would either go
    // through a seeded system user or — if we ever need free-form actor — a
    // future schema change to drop the FK / add a polymorphic actor column.)
    const workerActorId = nanoid();
    await db.insert(users).values({
      id: workerActorId,
      email: `worker-${workerActorId}@test.local`,
      name: 'Worker User',
    });
    await transitionRun(run.id, { newStatus: 'completed', actor: workerActorId });

    const after = await db.query.documents.findFirst({ where: eq(documents.id, run.id) });
    expect(after!.updatedBy).toBe(workerActorId);

    const completedEvents = await db.query.events.findMany({
      where: eq(events.kind, 'agent.run.completed'),
    });
    expect(completedEvents.length).toBe(1);
    expect(completedEvents[0]!.actor).toBe(workerActorId);
  });

  test('locks the bare-string errorDetail contract: input string → constant fallback (no leak surface)', async () => {
    // sanitizeProviderError is whitelist-based: any input WITHOUT a numeric
    // `.status` falls through to the constant 'Network error or unreachable
    // host.' branch — including a stringified-JSON of a structured error or
    // a free-form attacker-controlled message. This test locks that contract
    // so a future refactor of transitionRun can't accidentally start
    // round-tripping `args.errorDetail` into the persisted column.
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);
    const run = await seedRunningRun(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user);

    // A stringified-JSON SDK error — sanitizeProviderError does NOT JSON.parse;
    // it sees a string with no `.status` property → constant output.
    const stringifiedSdkError = JSON.stringify({
      status: 401,
      message: 'Incorrect API key: sk-leak-12345',
      requestId: 'req_abc',
    });
    await transitionRun(run.id, {
      newStatus: 'failed',
      actor: seed.user.id,
      errorReason: 'provider_error',
      errorDetail: stringifiedSdkError,
    });

    const after = await db.query.documents.findFirst({ where: eq(documents.id, run.id) });
    const fm = after!.frontmatter as AgentRunFrontmatter;
    // Constant fallback — NOT the 401 whitelist message, because the input is
    // a string (no `.status` to read).
    expect(fm.error_detail).toBe('Network error or unreachable host.');
    // Defense in depth — no credential / message fragment survives.
    expect(fm.error_detail).not.toContain('sk-leak-12345');
    expect(fm.error_detail).not.toContain('req_abc');
    expect(fm.error_detail).not.toContain('Incorrect API key');
  });

  // F2 regression — every → running transition stamps a fresh
  // worker_started_at. Before F2, only claimNextPlanningRun stamped it;
  // a direct planning → running via transitionRun (admin force-resume,
  // Sub-phase D approval-resume) left worker_started_at NULL, and
  // recoverOrphanRuns silently skipped the row forever.
  test('stamps worker_started_at on direct planning → running (orphan recovery sees it)', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    // Create a planning row via createRun (no claim — direct path).
    const created = await createRun({
      workspace: seed.workspace,
      project: seed.project,
      runsTable,
      agent,
      actor: seed.user,
      input: {
        parentDocumentId: parent.id,
        firedBy: 'agent.task.assigned',
        chainId: crypto.randomUUID(),
        triggerId: null,
      },
    });
    const fmBefore = created.document.frontmatter as AgentRunFrontmatter;
    expect(fmBefore.worker_started_at).toBeUndefined();

    const beforeIso = new Date(Date.now() - 1).toISOString();
    await transitionRun(created.document.id, {
      newStatus: 'running',
      actor: seed.user.id,
    });

    const after = await db.query.documents.findFirst({
      where: eq(documents.id, created.document.id),
    });
    const fmAfter = after!.frontmatter as AgentRunFrontmatter;
    expect(typeof fmAfter.worker_started_at).toBe('string');
    expect(fmAfter.worker_started_at!.length).toBeGreaterThan(0);
    // Stamped at "now" — sorts at or after the pre-call mark.
    expect(fmAfter.worker_started_at! >= beforeIso).toBe(true);
  });

  // F1 regression — TOCTOU race fix. Two concurrent transitionRun calls
  // from the same `from` state must yield exactly one winner; the loser
  // gets INVALID_RUN_TRANSITION 409 (mitigation 43's "loser no-ops").
  // Mirrors claimNextPlanningRun's race test shape but exercises the
  // approval-resume code path.
  test('exactly one of two concurrent transitions from the same state wins (race test, 50 iterations)', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    for (let i = 0; i < 50; i++) {
      // Fresh awaiting_approval row each iteration.
      const run = await seedRunAt(
        db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'awaiting_approval',
      );

      const results = await Promise.allSettled([
        transitionRun(run.id, { newStatus: 'running', actor: seed.user.id }),
        transitionRun(run.id, { newStatus: 'running', actor: seed.user.id }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      const loserErr = (rejected[0] as PromiseRejectedResult).reason as HTTPError;
      expect(loserErr).toBeInstanceOf(HTTPError);
      // R5 — race-loss is a distinct code (RUN_TRANSITION_RACED) from
      // genuine state-machine violation (INVALID_RUN_TRANSITION). The
      // bun:sqlite single-connection model serializes the two findFirsts
      // so the loser will EITHER hit the outer isValidTransition check
      // (INVALID_RUN_TRANSITION; running→running invalid) OR the inner
      // WHERE-status guard (RUN_TRANSITION_RACED) depending on whether
      // the winner's tx has committed before the loser's findFirst.
      // Both paths are valid loser outcomes, both indicate "lost the
      // race." This test pins the union behavior; the deterministic
      // F1-inner-throw test below pins the specific RUN_TRANSITION_RACED
      // code on the inner path.
      expect(
        loserErr.code === 'RUN_TRANSITION_RACED' ||
        loserErr.code === 'INVALID_RUN_TRANSITION',
      ).toBe(true);

      // Exactly one agent.run.running event for this row.
      const runEvents = await db.query.events.findMany({
        where: (e, { and: andOp, eq: eqOp }) =>
          andOp(eqOp(e.kind, 'agent.run.running'), eqOp(e.documentId, run.id)),
      });
      expect(runEvents.length).toBe(1);
    }
  });

  // R8 deterministic test — pin the F1 inner-throw path that the
  // bun:sqlite-single-connection race test rarely exercises. We force
  // a lockstep violation (column='running' but frontmatter.status='
  // awaiting_approval') so transitionRun's outer isValidTransition
  // sees 'awaiting_approval' (valid → running) but its inner UPDATE's
  // `WHERE status='awaiting_approval'` matches 0 rows because the
  // column is already 'running'. That's the exact pre-condition the
  // F1 fix defends against — the production version arises from a
  // concurrent transitionRun winner committing between our findFirst
  // and our UPDATE.
  test('throws RUN_TRANSITION_RACED on lockstep mismatch (inner-throw path)', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    const run = await seedRunAt(
      db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'awaiting_approval',
    );

    // Force lockstep violation: column = 'running' but
    // frontmatter.status stays 'awaiting_approval'. This is exactly
    // the post-race-winner state from the loser's perspective:
    //  - transitionRun's findFirst reads frontmatter.status =
    //    'awaiting_approval' (the JSON field — used to derive `from`).
    //  - isValidTransition('awaiting_approval','running') → true,
    //    passes outer check.
    //  - Inner UPDATE WHERE documents.status = 'awaiting_approval'
    //    (the COLUMN, which IS 'running') affects 0 rows → triggers
    //    RUN_TRANSITION_RACED inner throw.
    //
    // In production, mitigation 40 lockstep keeps column + JSON in
    // sync — but ONLY within a single tx. A concurrent winner that
    // commits between our findFirst (reading from JSON) and our
    // UPDATE (predicating on column) produces exactly this skew.
    await db.update(documents)
      .set({ status: 'running' })
      .where(eq(documents.id, run.id));

    let caught: HTTPError | undefined;
    try {
      await transitionRun(run.id, { newStatus: 'running', actor: seed.user.id });
    } catch (e) {
      caught = e as HTTPError;
    }
    expect(caught).toBeInstanceOf(HTTPError);
    expect(caught!.code).toBe('RUN_TRANSITION_RACED');

    // R6 — observedFrom reflects the COLUMN's actual value (what the
    // failed WHERE predicate evaluated against), not the frontmatter
    // snapshot. Aids triage of race vs ABI violation in Sub-phase D
    // approval handlers.
    const err = caught as HTTPError & { from: string; to: string; observedFrom: string | undefined };
    expect(err.from).toBe('awaiting_approval');
    expect(err.to).toBe('running');
    expect(err.observedFrom).toBe('running');
  });

  test('preserves existing worker_started_at when an awaiting_approval row resumes to running', async () => {
    // awaiting_approval → running is the Sub-phase D approval-resume path.
    // If the row was pre-claimed (worker_started_at set from a prior
    // running → awaiting_approval — currently not valid in the state
    // machine, but the helper plus a hand-edit can produce it; the
    // COALESCE branch must preserve), the original timestamp MUST
    // survive. Orphan recovery's threshold compares against that value.
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    const originalClaimIso = new Date(Date.now() - 60_000).toISOString();
    const run = await seedRunAt(
      db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'awaiting_approval',
      { workerStartedAt: originalClaimIso },
    );
    await transitionRun(run.id, { newStatus: 'running', actor: seed.user.id });

    const after = await db.query.documents.findFirst({ where: eq(documents.id, run.id) });
    const fmAfter = after!.frontmatter as AgentRunFrontmatter;
    expect(fmAfter.worker_started_at).toBe(originalClaimIso);
  });
});

// ---------- incrementTokens ----------

describe('incrementTokens', () => {
  test('atomically increments tokens_in and tokens_out across serial calls', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);
    const run = await seedRunningRun(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user);

    const first = await incrementTokens(run.id, { in: 10, out: 5 });
    expect(first).toEqual({ tokens_in: 10, tokens_out: 5 });
    const second = await incrementTokens(run.id, { in: 10, out: 5 });
    expect(second).toEqual({ tokens_in: 20, tokens_out: 10 });

    const after = await db.query.documents.findFirst({ where: eq(documents.id, run.id) });
    const fm = after!.frontmatter as AgentRunFrontmatter;
    expect(fm.tokens_in).toBe(20);
    expect(fm.tokens_out).toBe(10);
  });

  test('handles increment-by-zero as a no-op (no falsy-zero bug)', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);
    const run = await seedRunningRun(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user);

    await incrementTokens(run.id, { in: 7, out: 3 });
    const after = await incrementTokens(run.id, { in: 0, out: 0 });
    expect(after).toEqual({ tokens_in: 7, tokens_out: 3 });
  });

  test('COALESCEs from zero when frontmatter has no tokens_in/out keys', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    // Seed an old-shape row (missing tokens_in/out keys). Bypass the schema
    // by writing the row directly — emulates a row migrated in from an older
    // schema generation.
    const id = nanoid();
    const now = new Date().toISOString();
    await db.insert(documents).values({
      id,
      workspaceId: seed.workspace.id,
      projectId: seed.project.id,
      tableId: runsTable.id,
      type: 'agent_run',
      slug: `${agent.slug}-legacy-${nanoid(8)}`,
      title: 'legacy run',
      status: 'running',
      body: '',
      frontmatter: {
        assignee: `agent:${agent.slug}`,
        status: 'running',
        agent_slug: agent.slug,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        system_prompt: 'you are a helper.',
        max_tokens: 12_345,
        trigger_id: null,
        chain_id: crypto.randomUUID(),
        fired_by: 'agent.task.assigned',
        started_at: now,
      },
      parentId: parent.id,
      createdBy: seed.user.id,
      updatedBy: seed.user.id,
    });

    const out = await incrementTokens(id, { in: 13, out: 4 });
    expect(out).toEqual({ tokens_in: 13, tokens_out: 4 });
  });

  test('throws AGENT_RUN_NOT_FOUND when the id points at a non-agent_run document', async () => {
    // Without the type='agent_run' guard on the read-back, the UPDATE silently
    // no-ops (its where clause already filters) AND the read returns the
    // wrong row's tokens — masking the NOT_FOUND path entirely. Pass a
    // work_item id to assert the asymmetry is fixed: both UPDATE and read
    // must filter by type.
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const workItem = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);

    let caught: HTTPError | null = null;
    try {
      await incrementTokens(workItem.id, { in: 5, out: 3 });
    } catch (e) {
      caught = e as HTTPError;
    }
    expect(caught).toBeInstanceOf(HTTPError);
    expect(caught!.status).toBe(404);
    expect(caught!.code).toBe('AGENT_RUN_NOT_FOUND');
  });
});

// ---------- read helpers (getActiveRun, getPendingApprovalRun, listRuns) ----------

/**
 * Seed an agent_run row at an arbitrary status with an optional createdAt
 * override. Read helpers' tests need to control both ordering and status
 * across multiple rows on the same (parent, agent_slug). seedRunningRun
 * defaults to status='running' AND uses `new Date()` for createdAt, neither
 * of which is enough on its own.
 */
async function seedRunAt(
  db: TestDB,
  workspace: Workspace,
  project: Project,
  runsTable: TableEntity,
  agent: Document,
  parent: Document,
  user: User,
  status: AgentRunFrontmatter['status'],
  overrides: {
    createdAt?: Date;
    chainId?: string;
    workerStartedAt?: string;
    tokensIn?: number;
    tokensOut?: number;
    startedAt?: string;
    completedAt?: string;
  } = {},
): Promise<Document> {
  const id = nanoid();
  const now = new Date().toISOString();
  const fm: AgentRunFrontmatter = {
    assignee: `agent:${agent.slug}`,
    status,
    agent_slug: agent.slug,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    system_prompt: 'You are a helper.',
    max_tokens: 12_345,
    tokens_in: overrides.tokensIn ?? 0,
    tokens_out: overrides.tokensOut ?? 0,
    trigger_id: null,
    chain_id: overrides.chainId ?? crypto.randomUUID(),
    fired_by: 'agent.task.assigned',
    started_at: overrides.startedAt ?? now,
    ...(overrides.workerStartedAt !== undefined
      ? { worker_started_at: overrides.workerStartedAt }
      : {}),
    ...(overrides.completedAt !== undefined
      ? { completed_at: overrides.completedAt }
      : {}),
  };
  await db.insert(documents).values({
    id,
    workspaceId: workspace.id,
    projectId: project.id,
    tableId: runsTable.id,
    type: 'agent_run',
    slug: `${agent.slug}-${now.replace(/:/g, '-')}-${nanoid(8)}`,
    title: `${agent.slug} run`,
    status,
    body: '',
    frontmatter: fm as unknown as Record<string, unknown>,
    parentId: parent.id,
    createdBy: user.id,
    updatedBy: user.id,
    ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
  });
  const row = await db.query.documents.findFirst({ where: eq(documents.id, id) });
  return row!;
}

describe('getActiveRun', () => {
  test('returns the most recent non-terminal run for (parent, agentSlug)', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    // Older planning row, newer running row → running wins (most recent).
    await seedRunAt(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'planning', {
      createdAt: new Date(Date.now() - 60_000),
    });
    const newer = await seedRunAt(
      db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'running',
      { createdAt: new Date() },
    );

    const active = await getActiveRun({ parentId: parent.id, agentSlug: agent.slug });
    expect(active).not.toBeNull();
    expect(active!.id).toBe(newer.id);
    expect(active!.status).toBe('running');
  });

  test('returns null when only terminal runs exist', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    await seedRunAt(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'completed');
    await seedRunAt(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'failed');

    const active = await getActiveRun({ parentId: parent.id, agentSlug: agent.slug });
    expect(active).toBeNull();
  });

  test('returns null when no runs exist for the (parent, agent) pair', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const helper = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const other = await seedAgent(db, seed.workspace, seed.user, 'other');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    // An unrelated agent has a running row on the same parent — must not match
    // when we query for `helper`.
    await seedRunAt(db, seed.workspace, seed.project, runsTable, other, parent, seed.user, 'running');

    const active = await getActiveRun({ parentId: parent.id, agentSlug: helper.slug });
    expect(active).toBeNull();
  });

  test('ignores rows from other parents (scope predicate is parent_id)', async () => {
    // Mitigation 23 — parent_id is the scope predicate. Another work_item's
    // active run must not surface in this work_item's getActiveRun.
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parentA = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const parentB = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    await seedRunAt(db, seed.workspace, seed.project, runsTable, agent, parentA, seed.user, 'running');

    const active = await getActiveRun({ parentId: parentB.id, agentSlug: agent.slug });
    expect(active).toBeNull();
  });
});

describe('getPendingApprovalRun', () => {
  test('returns ONLY the awaiting_approval row for (parent, agentSlug)', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    await seedRunAt(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'planning');
    const pending = await seedRunAt(
      db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'awaiting_approval',
    );
    await seedRunAt(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'running');

    const found = await getPendingApprovalRun({ parentId: parent.id, agentSlug: agent.slug });
    expect(found).not.toBeNull();
    expect(found!.id).toBe(pending.id);
    expect(found!.status).toBe('awaiting_approval');
  });

  test('returns null when status is something else (running only)', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    await seedRunAt(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'running');

    const found = await getPendingApprovalRun({ parentId: parent.id, agentSlug: agent.slug });
    expect(found).toBeNull();
  });
});

describe('listRuns', () => {
  test('filters by workspaceId + status', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    const p1 = await seedRunAt(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'planning');
    const p2 = await seedRunAt(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'planning');
    await seedRunAt(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'running');

    const rows = await listRuns({ workspaceId: seed.workspace.id, status: 'planning' });
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual([p1.id, p2.id].sort());
  });

  test('filters by projectId + chainId (chain aggregation)', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    const chainId = crypto.randomUUID();
    const inChain1 = await seedRunAt(
      db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'running',
      { chainId },
    );
    const inChain2 = await seedRunAt(
      db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'completed',
      { chainId },
    );
    await seedRunAt(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'running');

    const rows = await listRuns({ projectId: seed.project.id, chainId });
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual([inChain1.id, inChain2.id].sort());
  });

  test('filters by `since` — only rows with createdAt >= since are returned', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    const oldStamp = new Date(Date.now() - 120_000);
    const newStamp = new Date();

    await seedRunAt(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'running', { createdAt: oldStamp });
    const recent = await seedRunAt(
      db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'running',
      { createdAt: newStamp },
    );

    const cutoff = new Date(Date.now() - 60_000).toISOString();
    const rows = await listRuns({ workspaceId: seed.workspace.id, since: cutoff });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(recent.id);
    expect(ids).toHaveLength(1);
  });

  test('throws INVALID_QUERY on invalid `since` timestamp', async () => {
    // Mirrors listComments(comments.ts): invalid `since` used to silently fall
    // through (no filter), so a polling worker passing a bad ISO got the FULL
    // list and would re-process every historical row. Surface clearly.
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    await seedRunAt(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'running');

    let caught: unknown;
    try {
      await listRuns({ workspaceId: seed.workspace.id, since: 'not-a-date' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HTTPError);
    expect((caught as HTTPError).code).toBe('INVALID_QUERY');
    expect((caught as HTTPError).status).toBe(422);
  });

  test('callerAgentProjectsAllowList=["*"] returns everything (no narrowing)', async () => {
    // Two projects in the same workspace, one row in each. The wildcard must
    // return BOTH rows — a test that seeded only one project would also pass
    // with `[seed.project.id]` (no wildcard skip), so it would not prove the
    // mitigation 24 wildcard short-circuit is intact.
    const { db, seed } = await makeTestApp();
    const table1 = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent1 = await seedWorkItem(db, seed.workspace, seed.project, table1, seed.user);
    const runsTable1 = await seedRunsTable(db, seed.project.id);

    const project2Id = nanoid();
    await db.insert(schemaProjects).values({
      id: project2Id,
      workspaceId: seed.workspace.id,
      slug: 'p2-wildcard',
      name: 'P2 Wildcard',
    });
    await seedProjectDefaults(db, project2Id);
    const project2 = (await db.query.projects.findFirst({
      where: (p, { eq: e }) => e(p.id, project2Id),
    }))!;
    const table2 = await getWorkItemsTable(db, project2.id);
    const parent2 = await seedWorkItem(db, seed.workspace, project2, table2, seed.user);
    const runsTable2 = await seedRunsTable(db, project2.id);

    const inP1 = await seedRunAt(db, seed.workspace, seed.project, runsTable1, agent, parent1, seed.user, 'running');
    const inP2 = await seedRunAt(db, seed.workspace, project2, runsTable2, agent, parent2, seed.user, 'planning');

    const rows = await listRuns({
      workspaceId: seed.workspace.id,
      callerAgentProjectsAllowList: ['*'],
    });
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual([inP1.id, inP2.id].sort());
  });

  test('callerAgentProjectsAllowList=[projectId] narrows to allowed projects (mitigation 24)', async () => {
    // Two projects in the same workspace. Allow-list only one — only that
    // project's run should come back.
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent1 = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable1 = await seedRunsTable(db, seed.project.id);

    const project2Id = nanoid();
    await db.insert(schemaProjects).values({
      id: project2Id,
      workspaceId: seed.workspace.id,
      slug: 'p2',
      name: 'P2',
    });
    await seedProjectDefaults(db, project2Id);
    const project2 = (await db.query.projects.findFirst({
      where: (p, { eq: e }) => e(p.id, project2Id),
    }))!;
    const table2 = await getWorkItemsTable(db, project2.id);
    const parent2 = await seedWorkItem(db, seed.workspace, project2, table2, seed.user);
    const runsTable2 = await seedRunsTable(db, project2.id);

    const inP1 = await seedRunAt(db, seed.workspace, seed.project, runsTable1, agent, parent1, seed.user, 'running');
    await seedRunAt(db, seed.workspace, project2, runsTable2, agent, parent2, seed.user, 'running');

    const rows = await listRuns({
      workspaceId: seed.workspace.id,
      callerAgentProjectsAllowList: [seed.project.id],
    });
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual([inP1.id]);
  });

  test('callerAgentProjectsAllowList=[] short-circuits to [] (mitigation 24, no `WHERE IN ()`)', async () => {
    // Seed a row to prove that the short-circuit is not just "no rows" by
    // accident — it's an explicit guard against SQLite's `IN ()` parse error.
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    await seedRunAt(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'running');

    const rows = await listRuns({
      workspaceId: seed.workspace.id,
      callerAgentProjectsAllowList: [],
    });
    expect(rows).toEqual([]);
  });

  test('EXPLAIN QUERY PLAN of getActiveRun uses a partial agent_run index', async () => {
    // The natural index for `WHERE type='agent_run' AND parent_id=? ORDER BY
    // created_at DESC` is `documents_runs_by_parent_idx` (parent_id,
    // created_at DESC) WHERE type='agent_run'. We assert on that index
    // because the planner has no incentive to choose
    // `documents_runs_by_status_idx` (its leading column is `table_id`, not
    // available in getActiveRun's input set).
    //
    // DIVERGENCE FROM PLAN: the plan brief says the EXPLAIN test should
    // verify `documents_runs_by_status_idx`, but that index is on
    // `(table_id, status, created_at DESC)` and the query has no `table_id`
    // predicate. Asserting on the index actually chosen — the parent-keyed
    // one — keeps the test load-bearing without forcing a query reshape that
    // adds an unused `table_id` predicate just to pin a misaligned index.
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);
    await seedRunAt(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'running');

    // Mirror getActiveRun's where clause shape in raw SQL so we EXPLAIN the
    // exact form Drizzle generates.
    const plan = await db.all(sql`
      EXPLAIN QUERY PLAN
      SELECT * FROM documents
      WHERE type = 'agent_run'
        AND parent_id = ${parent.id}
        AND status IN ('planning', 'awaiting_approval', 'running')
        AND json_extract(frontmatter, '$.agent_slug') = ${agent.slug}
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const stringified = JSON.stringify(plan);
    if (process.env.FOLIO_EXPLAIN_DEBUG) {
      // eslint-disable-next-line no-console
      console.log('EXPLAIN getActiveRun:', stringified);
    }
    expect(stringified).toContain('documents_runs_by_parent_idx');
  });
});

// ---------- sanitizer integration assumption ----------

describe('sanitizeProviderError integration guard', () => {
  test('discards SDK .message content for structured 401s (whitelist returns fixed string)', async () => {
    // This is the production-path guarantee transitionRun depends on: when
    // the runner (C-2+) passes a structured SDK error object through
    // `sanitizeProviderError`, no credential-bearing fragment from the
    // upstream `.message` can survive. We test the sanitizer directly here
    // because transitionRun currently accepts `errorDetail: string` only —
    // this regression guard locks the upstream contract.
    const sdkError = {
      status: 401,
      message: 'Incorrect API key provided: sk-leak-12345. Find it at...',
      requestId: 'req_attacker_owned',
    };
    const out = sanitizeProviderError(sdkError, 'anthropic');
    // Whitelist output — no SDK message body, no key fragment, no requestId.
    expect(out).toBe('Unauthorized (401): key rejected by anthropic.');
    expect(out).not.toContain('sk-leak-12345');
    expect(out).not.toContain('req_attacker_owned');
    expect(out).not.toContain('Incorrect API key');
  });
});

// ---------- claimNextPlanningRun ----------

describe('claimNextPlanningRun', () => {
  test('returns null when no planning rows exist', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    // Seed running + completed rows — neither claimable.
    await seedRunAt(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'running');
    await seedRunAt(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'completed');

    const claimed = await db.transaction(async (tx) => claimNextPlanningRun(tx));
    expect(claimed).toBeNull();
  });

  test('claims oldest planning row by created_at ASC and flips status + worker_started_at', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    const older = await seedRunAt(
      db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'planning',
      { createdAt: new Date(Date.now() - 60_000) },
    );
    await seedRunAt(
      db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'planning',
      { createdAt: new Date() },
    );

    const claimed = await db.transaction(async (tx) => claimNextPlanningRun(tx));
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(older.id);
    // documents.status column + frontmatter.status flipped in lockstep (mitigation 40).
    expect(claimed!.status).toBe('running');
    const fm = claimed!.frontmatter as AgentRunFrontmatter;
    expect(fm.status).toBe('running');
    expect(typeof fm.worker_started_at).toBe('string');
    expect(fm.worker_started_at!.length).toBeGreaterThan(0);
  });

  test('exactly one of two concurrent claimers wins the same row (race test, 100 iterations)', async () => {
    // Mitigation 36 — atomic claim under SQLite's transaction semantics.
    // We seed exactly ONE planning row per iteration, then race two
    // independent transactions calling claimNextPlanningRun. Exactly one
    // must return the row; the other must return null. If both win, the
    // UPDATE ... WHERE status='planning' guard is broken and rows could be
    // double-claimed across worker instances.
    //
    // Per [[mock-the-wire-not-the-response]]: real SQLite, no stubs.
    // 100 iterations defeats single-pass scheduler luck.
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    for (let i = 0; i < 100; i++) {
      await seedRunAt(
        db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'planning',
      );

      const [a, b] = await Promise.all([
        db.transaction(async (tx) => claimNextPlanningRun(tx)),
        db.transaction(async (tx) => claimNextPlanningRun(tx)),
      ]);

      const winners = [a, b].filter((r): r is Document => r !== null);
      expect(winners.length).toBe(1);

      // Cleanup: transition the claimed (now running) row to a terminal
      // state so the next iteration starts with zero claimable rows.
      // transitionRun manages its own tx; runs the actor as the agent slug
      // to match the runner's convention.
      // Use a real user id for FK satisfaction. transitionRun writes
      // updatedBy → documents.updated_by → users.id. Production code path
      // (the runner) uses the agent's owner user id; tests use seed.user.id
      // for the same reason.
      await transitionRun(winners[0]!.id, {
        newStatus: 'failed',
        actor: seed.user.id,
        errorReason: 'cancelled',
      });
    }
  });
});

// F8 regression — raw-SQL paths must write ms-epoch numbers into the INTEGER
// `updated_at` column, NOT ISO strings. SQLite's INTEGER affinity stores
// non-numeric strings as TEXT, and ORDER BY then sorts all numerics before
// all text regardless of magnitude — a freshly claimed run would sort AFTER
// every Drizzle-written row, breaking dashboards.
describe('updated_at is an INTEGER ms-epoch across raw-SQL + Drizzle write paths', () => {
  test('claimNextPlanningRun writes a numeric updated_at that sorts correctly with Drizzle-written rows', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    // Drizzle-write path: createRun. Row sits at planning.
    const drizzleRun = await createRun({
      workspace: seed.workspace,
      project: seed.project,
      runsTable,
      agent,
      actor: seed.user,
      input: {
        parentDocumentId: parent.id,
        firedBy: 'agent.task.assigned',
        chainId: crypto.randomUUID(),
        triggerId: null,
      },
    });
    // Push createRun's updated_at firmly into the past, then settle the
    // row at a non-planning status so the claim picks the SECOND planning
    // row we seed below. Drizzle's .update writes via the integer path,
    // so updated_at after this is a number.
    const drizzlePastMs = Date.now() - 10_000;
    await db.update(documents)
      .set({ updatedAt: new Date(drizzlePastMs), status: 'completed' })
      .where(eq(documents.id, drizzleRun.document.id));

    // Seed a SECOND, fresh planning row for the claim. seedRunAt insert
    // also goes through Drizzle (writes updated_at as integer).
    const claimable = await seedRunAt(
      db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'planning',
    );

    const beforeClaim = Date.now();
    const claimed = await db.transaction(async (tx) => claimNextPlanningRun(tx));
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(claimable.id);

    // Read both rows' raw updated_at column via SQL — bypassing Drizzle's
    // Date deserialization. If F8 regressed, claimed.updated_at would be
    // a TEXT-affinity ISO string and the typeof check would fail; with
    // F8 in place both are numeric ms-epoch and ORDER BY is chronological.
    const rows = await db.all<{ id: string; updated_at: number | string }>(sql`
      SELECT id, updated_at FROM documents
       WHERE id IN (${drizzleRun.document.id}, ${claimable.id})
       ORDER BY updated_at ASC
    `);
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(typeof r.updated_at).toBe('number');
    }
    // Claimed (raw-SQL) row was updated AFTER the Drizzle-completed row.
    expect(rows[0]!.id).toBe(drizzleRun.document.id);
    expect(rows[1]!.id).toBe(claimable.id);
    expect((rows[1]!.updated_at as number)).toBeGreaterThanOrEqual(beforeClaim);
  });
});

// ---------- recoverOrphanRuns ----------

describe('recoverOrphanRuns', () => {
  test('transitions stale running rows to failed with error_reason=worker_crash', async () => {
    // Mitigation 37 — recovery boundary is `worker_started_at < threshold`
    // AND status='running'. Fresh runners are untouched; transitioned rows
    // (completed/failed) are untouched.
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    const stale = await seedRunAt(
      db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'running',
      { workerStartedAt: new Date(Date.now() - 10 * 60_000).toISOString() },
    );

    const recovered = await recoverOrphanRuns({ staleThresholdMs: 5 * 60_000 });
    expect(recovered).toEqual([stale.id]);

    // Row is now failed + worker_started_at cleared + completed_at set.
    const row = await db.query.documents.findFirst({ where: eq(documents.id, stale.id) });
    expect(row!.status).toBe('failed');
    const fm = row!.frontmatter as AgentRunFrontmatter;
    expect(fm.status).toBe('failed');
    expect(fm.error_reason).toBe('worker_crash');
    expect(fm.worker_started_at).toBeNull();
    expect(typeof fm.completed_at).toBe('string');

    // Event emitted, scoped to the workspace + project.
    const failedEvents = await db.query.events.findMany({
      where: eq(events.kind, 'agent.run.failed'),
    });
    expect(failedEvents.length).toBe(1);
    expect(failedEvents[0]!.documentId).toBe(stale.id);
    expect(failedEvents[0]!.workspaceId).toBe(seed.workspace.id);
    expect(failedEvents[0]!.projectId).toBe(seed.project.id);
  });

  test('skips rows whose worker_started_at is fresher than threshold', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    const fresh = await seedRunAt(
      db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'running',
      { workerStartedAt: new Date(Date.now() - 10_000).toISOString() }, // 10s ago
    );

    const recovered = await recoverOrphanRuns({ staleThresholdMs: 5 * 60_000 });
    expect(recovered).toEqual([]);

    // Row unchanged.
    const row = await db.query.documents.findFirst({ where: eq(documents.id, fresh.id) });
    expect(row!.status).toBe('running');
  });

  test('skips rows whose status is no longer running (mitigation 37 status predicate)', async () => {
    // The race the predicate guards: a row was running with stale
    // worker_started_at, then a different code path transitioned it to
    // completed. Recovery must NOT flip it back to failed.
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    // Seed a row that LOOKS orphaned (stale worker_started_at) but has
    // already transitioned to completed (status mismatch).
    const completed = await seedRunAt(
      db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'completed',
      { workerStartedAt: new Date(Date.now() - 10 * 60_000).toISOString() },
    );

    const recovered = await recoverOrphanRuns({ staleThresholdMs: 5 * 60_000 });
    expect(recovered).toEqual([]);

    const row = await db.query.documents.findFirst({ where: eq(documents.id, completed.id) });
    expect(row!.status).toBe('completed');
    const fm = row!.frontmatter as AgentRunFrontmatter;
    expect(fm.error_reason).toBeUndefined();
  });

  // F7 regression — recovery flushes persisted provider-health state by
  // calling maybeEmitProviderHealthEdge per distinct (workspace, provider)
  // pair. Without it, a workspace that previously tipped degraded could
  // carry that state for an arbitrarily long time after the underlying
  // provider failures aged out of the window — surfacing as stale data
  // in the runner-stats UI.
  test('flushes stale degraded persisted state by re-evaluating per provider after recovery', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    // Persist a stale degraded state for anthropic — as if a prior
    // provider outage tipped the edge, but the underlying events are
    // not in the recent window. Combined with no events in the SQL
    // filter's window, checkProviderHealth returns next.healthy.
    await db.update(workspaces).set({
      providerHealth: { anthropic: { status: 'degraded', consecutive_failures: 3 } },
    }).where(eq(workspaces.id, seed.workspace.id));

    // Seed a single stale running row (worker_started_at older than threshold).
    await seedRunAt(
      db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'running',
      { workerStartedAt: new Date(Date.now() - 10 * 60_000).toISOString() },
    );

    // Recovery — converts to failed/worker_crash. F7 fires
    // maybeEmitProviderHealthEdge for (workspace, anthropic) which sees
    // current=degraded, next=healthy (insufficient signal post-F5) →
    // persists healthy + emits a workspace.provider.recovered event.
    const recovered = await recoverOrphanRuns({ staleThresholdMs: 5 * 60_000 });
    expect(recovered.length).toBe(1);

    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, seed.workspace.id) });
    expect(ws!.providerHealth.anthropic?.status).toBe('healthy');

    const recoveredEvents = await db.query.events.findMany({
      where: eq(events.kind, 'workspace.provider.recovered'),
    });
    expect(recoveredEvents.length).toBe(1);
    expect((recoveredEvents[0]!.payload as { provider: string }).provider).toBe('anthropic');
    // F4 — workspace-scoped event must carry projectId=null.
    expect(recoveredEvents[0]!.projectId).toBeNull();
    // F7 — actor identifies the recovery path.
    expect(recoveredEvents[0]!.actor).toBe('system:orphan-recovery');
  });

  test('does NOT emit a duplicate edge when recovery touches multiple runs in the same (workspace, provider)', async () => {
    // Defense-in-depth — three orphan rows in the same workspace + provider
    // produce ONE provider-health edge call total (dedup by Set), not three.
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    await db.update(workspaces).set({
      providerHealth: { anthropic: { status: 'degraded', consecutive_failures: 3 } },
    }).where(eq(workspaces.id, seed.workspace.id));

    for (let i = 0; i < 3; i++) {
      await seedRunAt(
        db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'running',
        { workerStartedAt: new Date(Date.now() - 10 * 60_000).toISOString() },
      );
    }

    const recovered = await recoverOrphanRuns({ staleThresholdMs: 5 * 60_000 });
    expect(recovered.length).toBe(3);

    const recoveredEvents = await db.query.events.findMany({
      where: eq(events.kind, 'workspace.provider.recovered'),
    });
    expect(recoveredEvents.length).toBe(1);
  });
});

// ---------- countPendingPlanning ----------

describe('countPendingPlanning', () => {
  test('returns the number of agent_run rows at status=planning', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    await seedRunAt(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'planning');
    await seedRunAt(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'planning');
    await seedRunAt(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'running');
    await seedRunAt(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'completed');

    const count = await db.transaction(async (tx) => countPendingPlanning(tx));
    expect(count).toBe(2);
  });

  test('returns 0 when no planning rows exist', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    await seedRunAt(db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'running');

    const count = await db.transaction(async (tx) => countPendingPlanning(tx));
    expect(count).toBe(0);
  });
});

// ---------- checkRunRateLimits ----------

/**
 * Direct event seed for rate-limit tests. Inserts an `agent.run.started`
 * event with explicit `createdAt` so we can simulate "N events in the last
 * hour" without time-traveling the clock.
 */
async function seedRunStartedEvent(
  db: TestDB,
  args: {
    workspaceId: string;
    projectId: string | null;
    agentSlug: string;
    createdAt: Date;
    seq: number;
  },
): Promise<void> {
  await db.insert(events).values({
    id: nanoid(),
    workspaceId: args.workspaceId,
    projectId: args.projectId,
    documentId: nanoid(),
    kind: 'agent.run.started',
    actor: null,
    payload: { agent: args.agentSlug } as unknown as Record<string, unknown>,
    createdAt: args.createdAt,
    seq: args.seq,
  });
}

/**
 * Type narrowing for GuardResult — the discriminated union forces callers
 * to check `ok` before reading `detail`, but tests want a one-liner. This
 * helper throws if the result is OK so the subsequent `result.detail`
 * access type-checks via the asserts predicate.
 */
function expectGuardFailure<T extends { ok: boolean }>(
  result: T,
): asserts result is Extract<T, { ok: false }> {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected guard failure, got ok');
}

describe('checkRunRateLimits', () => {
  test('returns ok when both workspace + agent counts are under cap', async () => {
    const { db, seed } = await makeTestApp();
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');

    // 1 started event in the last hour — well under any sane cap.
    await seedRunStartedEvent(db, {
      workspaceId: seed.workspace.id,
      projectId: seed.project.id,
      agentSlug: agent.slug,
      createdAt: new Date(Date.now() - 30_000),
      seq: 1_000_001,
    });

    const result = await checkRunRateLimits({
      workspaceId: seed.workspace.id,
      agentSlug: agent.slug,
      workspaceMaxRunsPerHour: 200,
      agentMaxRunsPerHour: 60,
    });
    expect(result.ok).toBe(true);
  });

  test('returns rate_limited with workspace detail when workspace cap is hit', async () => {
    const { db, seed } = await makeTestApp();
    const agentA = await seedAgent(db, seed.workspace, seed.user, 'helper-a');
    const agentB = await seedAgent(db, seed.workspace, seed.user, 'helper-b');

    // Workspace cap of 5; seed 5 in the last hour split across two agents
    // so the workspace count exceeds cap but neither agent individually does.
    for (let i = 0; i < 3; i++) {
      await seedRunStartedEvent(db, {
        workspaceId: seed.workspace.id,
        projectId: seed.project.id,
        agentSlug: agentA.slug,
        createdAt: new Date(Date.now() - (i + 1) * 1000),
        seq: 2_000_001 + i,
      });
    }
    for (let i = 0; i < 3; i++) {
      await seedRunStartedEvent(db, {
        workspaceId: seed.workspace.id,
        projectId: seed.project.id,
        agentSlug: agentB.slug,
        createdAt: new Date(Date.now() - (i + 1) * 1000),
        seq: 2_100_001 + i,
      });
    }

    const result = await checkRunRateLimits({
      workspaceId: seed.workspace.id,
      agentSlug: agentA.slug,
      workspaceMaxRunsPerHour: 5,
      agentMaxRunsPerHour: 60,
    });
    expectGuardFailure(result);
    expect(result.reason).toBe('rate_limited');
    expect(result.detail).toMatch(/workspace/i);
  });

  test('returns rate_limited with agent detail when agent cap is hit', async () => {
    const { db, seed } = await makeTestApp();
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');

    // 4 events for one agent, cap=3 (agent), workspace cap=200 (not hit).
    for (let i = 0; i < 4; i++) {
      await seedRunStartedEvent(db, {
        workspaceId: seed.workspace.id,
        projectId: seed.project.id,
        agentSlug: agent.slug,
        createdAt: new Date(Date.now() - (i + 1) * 1000),
        seq: 3_000_001 + i,
      });
    }

    const result = await checkRunRateLimits({
      workspaceId: seed.workspace.id,
      agentSlug: agent.slug,
      workspaceMaxRunsPerHour: 200,
      agentMaxRunsPerHour: 3,
    });
    expectGuardFailure(result);
    expect(result.reason).toBe('rate_limited');
    expect(result.detail).toMatch(/agent/i);
  });

  test('prefers workspace failure when both caps are hit (deterministic ordering)', async () => {
    const { db, seed } = await makeTestApp();
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');

    // 5 events for the agent; both caps = 3, both hit. Workspace wins.
    for (let i = 0; i < 5; i++) {
      await seedRunStartedEvent(db, {
        workspaceId: seed.workspace.id,
        projectId: seed.project.id,
        agentSlug: agent.slug,
        createdAt: new Date(Date.now() - (i + 1) * 1000),
        seq: 4_000_001 + i,
      });
    }

    const result = await checkRunRateLimits({
      workspaceId: seed.workspace.id,
      agentSlug: agent.slug,
      workspaceMaxRunsPerHour: 3,
      agentMaxRunsPerHour: 3,
    });
    expectGuardFailure(result);
    expect(result.reason).toBe('rate_limited');
    expect(result.detail).toMatch(/workspace/i);
    expect(result.detail).not.toMatch(/agent/i);
  });

  test('excludes events older than one hour from the window', async () => {
    const { db, seed } = await makeTestApp();
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');

    // 5 events 90 minutes ago (outside window) + 1 event 30s ago.
    // Cap=2 — would fail if old events counted, passes when they don't.
    for (let i = 0; i < 5; i++) {
      await seedRunStartedEvent(db, {
        workspaceId: seed.workspace.id,
        projectId: seed.project.id,
        agentSlug: agent.slug,
        createdAt: new Date(Date.now() - 90 * 60_000),
        seq: 5_000_001 + i,
      });
    }
    await seedRunStartedEvent(db, {
      workspaceId: seed.workspace.id,
      projectId: seed.project.id,
      agentSlug: agent.slug,
      createdAt: new Date(Date.now() - 30_000),
      seq: 5_100_001,
    });

    const result = await checkRunRateLimits({
      workspaceId: seed.workspace.id,
      agentSlug: agent.slug,
      workspaceMaxRunsPerHour: 2,
      agentMaxRunsPerHour: 2,
    });
    expect(result.ok).toBe(true);
  });
});

// ---------- checkChainGuards ----------

describe('checkChainGuards', () => {
  test('returns ok when chain is under all caps', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);
    const chainId = crypto.randomUUID();

    // 3 rows, total 600 tokens, 10s wall time — comfortably under defaults.
    for (let i = 0; i < 3; i++) {
      await seedRunAt(
        db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'completed',
        {
          chainId,
          tokensIn: 100,
          tokensOut: 100,
          startedAt: new Date(Date.now() - 10_000).toISOString(),
          completedAt: new Date().toISOString(),
        },
      );
    }

    const result = await checkChainGuards({
      chainId,
      maxFanout: 25,
      maxChainDurationMs: 30 * 60_000,
      maxChainTokens: 1_000_000,
    });
    expect(result.reason).toBeNull();
  });

  test('returns fanout_exceeded when run count > maxFanout', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);
    const chainId = crypto.randomUUID();

    for (let i = 0; i < 6; i++) {
      await seedRunAt(
        db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'completed',
        { chainId },
      );
    }

    const result = await checkChainGuards({
      chainId,
      maxFanout: 5,
      maxChainDurationMs: 30 * 60_000,
      maxChainTokens: 1_000_000,
    });
    expectGuardFailure(result);
    expect(result.reason).toBe('fanout_exceeded');
    expect(result.detail).toMatch(/6 runs|fanout/i);
  });

  test('returns chain_duration_exceeded when max-min wall time > cap', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);
    const chainId = crypto.randomUUID();

    const startedAt = new Date(Date.now() - 60 * 60_000).toISOString();   // 1h ago
    const completedAt = new Date(Date.now() - 10_000).toISOString();      // ~now

    await seedRunAt(
      db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'completed',
      { chainId, startedAt, completedAt },
    );
    await seedRunAt(
      db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'completed',
      { chainId, startedAt, completedAt },
    );

    const result = await checkChainGuards({
      chainId,
      maxFanout: 25,
      maxChainDurationMs: 30 * 60_000, // 30 min cap; actual ≈ 60 min
      maxChainTokens: 1_000_000,
    });
    expectGuardFailure(result);
    expect(result.reason).toBe('chain_duration_exceeded');
    expect(result.detail).toMatch(/duration|ms/i);
  });

  test('returns chain_tokens_exceeded when sum(tokens_in + tokens_out) > cap', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);
    const chainId = crypto.randomUUID();

    // 3 rows × 2000 tokens = 6000; cap=5000.
    for (let i = 0; i < 3; i++) {
      await seedRunAt(
        db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'completed',
        { chainId, tokensIn: 1000, tokensOut: 1000 },
      );
    }

    const result = await checkChainGuards({
      chainId,
      maxFanout: 25,
      maxChainDurationMs: 30 * 60_000,
      maxChainTokens: 5000,
    });
    expectGuardFailure(result);
    expect(result.reason).toBe('chain_tokens_exceeded');
    expect(result.detail).toMatch(/tokens|6000/i);
  });

  test('prefers fanout_exceeded when multiple caps are hit (deterministic ordering)', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);
    const chainId = crypto.randomUUID();

    // 6 rows, each 10k tokens (60k total), 60min wall — ALL three caps hit.
    const startedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const completedAt = new Date().toISOString();
    for (let i = 0; i < 6; i++) {
      await seedRunAt(
        db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'completed',
        { chainId, tokensIn: 5000, tokensOut: 5000, startedAt, completedAt },
      );
    }

    const result = await checkChainGuards({
      chainId,
      maxFanout: 5,
      maxChainDurationMs: 30 * 60_000,
      maxChainTokens: 50_000,
    });
    // Fanout is checked first per the mitigation 29 ordering.
    expect(result.reason).toBe('fanout_exceeded');
  });

  test('ignores rows from other chains (chain_id scope)', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);
    const myChain = crypto.randomUUID();
    const otherChain = crypto.randomUUID();

    // 100 rows in otherChain — should not affect myChain's fanout count.
    for (let i = 0; i < 100; i++) {
      await seedRunAt(
        db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'completed',
        { chainId: otherChain },
      );
    }
    // 3 rows in myChain — well under cap.
    for (let i = 0; i < 3; i++) {
      await seedRunAt(
        db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'completed',
        { chainId: myChain },
      );
    }

    const result = await checkChainGuards({
      chainId: myChain,
      maxFanout: 5,
      maxChainDurationMs: 30 * 60_000,
      maxChainTokens: 1_000_000,
    });
    expect(result.reason).toBeNull();
  });

  test('EXPLAIN QUERY PLAN for checkChainGuards uses documents_runs_by_chain_idx', async () => {
    // Mitigation 29 volume guard (per plan): seed enough rows that the
    // planner would skip the index for full scans on small tables, then
    // assert EXPLAIN picks the chain index. Lacks env-skip per the plan
    // suggestion — bun:test has no test.skipIf, and 2k rows is fast.
    //
    // Why 2k and not 10k from the plan: 10k inserts via INSERT-each is
    // too slow (~20s); 2k still trips SQLite's planner heuristics for
    // index-vs-scan on the chain_id residual filter (verified locally).
    // The intent — guard against a planner regression that drops the
    // partial index — still holds at 2k.
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    // 2k rows across ~100 chain ids, batch-insert via raw SQL for speed.
    // Bypass createRun's transactional emit — this is shape-only seeding
    // for the EXPLAIN plan, not behavior verification.
    const chainIds = Array.from({ length: 100 }, () => crypto.randomUUID());
    const targetChainId = chainIds[0]!;
    const now = new Date().toISOString();
    for (let i = 0; i < 2_000; i++) {
      const id = nanoid();
      const chainId = chainIds[i % chainIds.length]!;
      const fm = {
        assignee: `agent:${agent.slug}`,
        status: 'completed',
        agent_slug: agent.slug,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        system_prompt: 'x',
        max_tokens: 1000,
        tokens_in: 10,
        tokens_out: 10,
        trigger_id: null,
        chain_id: chainId,
        fired_by: 'agent.task.assigned',
        started_at: now,
        completed_at: now,
      };
      await db.insert(documents).values({
        id,
        workspaceId: seed.workspace.id,
        projectId: seed.project.id,
        tableId: runsTable.id,
        type: 'agent_run',
        slug: `${agent.slug}-bulk-${i}`,
        title: `${agent.slug} bulk ${i}`,
        status: 'completed',
        body: '',
        frontmatter: fm as unknown as Record<string, unknown>,
        parentId: parent.id,
        createdBy: seed.user.id,
        updatedBy: seed.user.id,
      });
    }

    // ANALYZE so the planner has stats to make a real choice. Without
    // ANALYZE on a fresh table, SQLite often chooses scan even when the
    // index would win.
    await db.all(sql`ANALYZE`);

    // Mirror checkChainGuards' core query in raw SQL so we EXPLAIN the
    // exact shape Drizzle generates.
    const plan = await db.all(sql`
      EXPLAIN QUERY PLAN
      SELECT COUNT(*) AS fanout,
             MIN(json_extract(frontmatter, '$.started_at')) AS first_started,
             MAX(json_extract(frontmatter, '$.completed_at')) AS last_completed,
             COALESCE(SUM(
               COALESCE(json_extract(frontmatter, '$.tokens_in'), 0) +
               COALESCE(json_extract(frontmatter, '$.tokens_out'), 0)
             ), 0) AS tokens_total
        FROM documents
       WHERE type = 'agent_run'
         AND json_extract(frontmatter, '$.chain_id') = ${targetChainId}
    `);
    const planStr = JSON.stringify(plan);
    if (process.env.FOLIO_EXPLAIN_DEBUG) {
      // eslint-disable-next-line no-console
      console.log('EXPLAIN checkChainGuards:', planStr);
    }
    expect(planStr).toContain('documents_runs_by_chain_idx');
  }, 60_000);
});

// ---------- checkProviderHealth ----------

/**
 * Seed a run's terminal event directly — bypasses transitionRun's
 * tipping-edge wiring so provider-health tests can build up a fixed event
 * window without firing the very thing under test. Insert is into both
 * `events` and the underlying `documents` row (so the JOIN on
 * `documents.frontmatter.provider` resolves).
 *
 * `kind` is one of 'agent.run.completed' | 'agent.run.failed'.
 * `errorReason` only meaningful for the failed kind.
 */
async function seedTerminalRunEvent(
  db: TestDB,
  args: {
    workspace: Workspace;
    project: Project;
    runsTable: TableEntity;
    agent: Document;
    parent: Document;
    user: User;
    provider: AgentRunFrontmatter['provider'];
    kind: 'agent.run.completed' | 'agent.run.failed';
    errorReason?: string | null;
    seq: number;
    createdAtMs?: number;
  },
): Promise<{ runId: string; eventId: string }> {
  const runId = nanoid();
  const eventId = nanoid();
  const now = new Date().toISOString();
  const status = args.kind === 'agent.run.completed' ? 'completed' : 'failed';
  const fm: AgentRunFrontmatter = {
    assignee: `agent:${args.agent.slug}`,
    status,
    agent_slug: args.agent.slug,
    provider: args.provider,
    model: 'claude-sonnet-4-6',
    system_prompt: 'x',
    max_tokens: 1000,
    tokens_in: 0,
    tokens_out: 0,
    trigger_id: null,
    chain_id: crypto.randomUUID(),
    fired_by: 'agent.task.assigned',
    started_at: now,
    completed_at: now,
    ...(args.errorReason ? { error_reason: args.errorReason as never } : {}),
  };
  await db.insert(documents).values({
    id: runId,
    workspaceId: args.workspace.id,
    projectId: args.project.id,
    tableId: args.runsTable.id,
    type: 'agent_run',
    slug: `${args.agent.slug}-evt-${nanoid(6)}`,
    title: `${args.agent.slug} run`,
    status,
    body: '',
    frontmatter: fm as unknown as Record<string, unknown>,
    parentId: args.parent.id,
    createdBy: args.user.id,
    updatedBy: args.user.id,
  });
  await db.insert(events).values({
    id: eventId,
    workspaceId: args.workspace.id,
    projectId: args.project.id,
    documentId: runId,
    kind: args.kind,
    actor: null,
    payload: {
      from: 'running',
      to: status,
      error_reason: args.errorReason ?? null,
    } as unknown as Record<string, unknown>,
    createdAt: new Date(args.createdAtMs ?? Date.now() - (1_000_000 - args.seq * 1000)),
    seq: args.seq,
  });
  return { runId, eventId };
}

describe('checkProviderHealth', () => {
  test('returns healthy with 0 failures when no events exist', async () => {
    const { db, seed } = await makeTestApp();

    const result = await checkProviderHealth({
      workspaceId: seed.workspace.id,
      provider: 'anthropic',
      threshold: 3,
    });
    expect(result.current).toEqual({ status: 'healthy', consecutive_failures: 0 });
    expect(result.next).toEqual({ status: 'healthy', consecutive_failures: 0 });
  });

  test('next is degraded after threshold consecutive provider_error failures', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    for (let i = 0; i < 3; i++) {
      await seedTerminalRunEvent(db, {
        workspace: seed.workspace, project: seed.project, runsTable,
        agent, parent, user: seed.user,
        provider: 'anthropic',
        kind: 'agent.run.failed',
        errorReason: 'provider_error',
        seq: 7_000_000 + i,
      });
    }

    const result = await checkProviderHealth({
      workspaceId: seed.workspace.id,
      provider: 'anthropic',
      threshold: 3,
    });
    expect(result.next.status).toBe('degraded');
    expect(result.next.consecutive_failures).toBe(3);
  });

  test('excludes cancelled error_reason from the window', async () => {
    // Window of 3 non-cancelled events should yield degraded even when
    // a `cancelled` event happens between the failures (don't count it).
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    // Order (newest last): fail, fail, cancelled, fail
    // After excluding cancelled, the last 3 are: fail, fail, fail → degraded.
    await seedTerminalRunEvent(db, {
      workspace: seed.workspace, project: seed.project, runsTable,
      agent, parent, user: seed.user,
      provider: 'anthropic',
      kind: 'agent.run.failed',
      errorReason: 'provider_error',
      seq: 7_100_001,
    });
    await seedTerminalRunEvent(db, {
      workspace: seed.workspace, project: seed.project, runsTable,
      agent, parent, user: seed.user,
      provider: 'anthropic',
      kind: 'agent.run.failed',
      errorReason: 'provider_error',
      seq: 7_100_002,
    });
    await seedTerminalRunEvent(db, {
      workspace: seed.workspace, project: seed.project, runsTable,
      agent, parent, user: seed.user,
      provider: 'anthropic',
      kind: 'agent.run.failed',
      errorReason: 'cancelled',
      seq: 7_100_003,
    });
    await seedTerminalRunEvent(db, {
      workspace: seed.workspace, project: seed.project, runsTable,
      agent, parent, user: seed.user,
      provider: 'anthropic',
      kind: 'agent.run.failed',
      errorReason: 'provider_error',
      seq: 7_100_004,
    });

    const result = await checkProviderHealth({
      workspaceId: seed.workspace.id,
      provider: 'anthropic',
      threshold: 3,
    });
    expect(result.next.status).toBe('degraded');
  });

  // F5 regression — infrastructure-class error_reasons (worker_crash from
  // orphan recovery, budget_exceeded, rate_limited, depth_exceeded,
  // fanout_exceeded, chain_*_exceeded, no_ai_key, idempotency_violation,
  // rejected) are EXCLUDED at the SQL layer. Pre-F5, the SQL excluded
  // only 'cancelled' and the JS loop broke on any non-provider_error
  // row — so a single worker_crash midway through a degraded streak
  // reset next.status to healthy and triggered a spurious recovered.
  test('worker_crash failures do NOT break a still-degraded provider streak', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    // Order (oldest first): 3× provider_error, then a worker_crash on top.
    // Pre-F5: the worker_crash as newest event broke the loop, returning
    // next.healthy with 0 trailing failures.
    // Post-F5: the SQL drops the worker_crash row; loop sees 3
    // provider_errors → degraded.
    for (let i = 0; i < 3; i++) {
      await seedTerminalRunEvent(db, {
        workspace: seed.workspace, project: seed.project, runsTable,
        agent, parent, user: seed.user,
        provider: 'anthropic',
        kind: 'agent.run.failed',
        errorReason: 'provider_error',
        seq: 9_000_001 + i,
      });
    }
    await seedTerminalRunEvent(db, {
      workspace: seed.workspace, project: seed.project, runsTable,
      agent, parent, user: seed.user,
      provider: 'anthropic',
      kind: 'agent.run.failed',
      errorReason: 'worker_crash',
      seq: 9_000_004,
    });

    const result = await checkProviderHealth({
      workspaceId: seed.workspace.id,
      provider: 'anthropic',
      threshold: 3,
    });
    expect(result.next.status).toBe('degraded');
    expect(result.next.consecutive_failures).toBe(3);
  });

  test('budget_exceeded failures do NOT count toward provider degradation', async () => {
    // Defense-in-depth — confirms the SQL filter excludes other
    // infrastructure-class reasons too, not just worker_crash.
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    // 5 budget_exceeded failures — none are provider signals.
    for (let i = 0; i < 5; i++) {
      await seedTerminalRunEvent(db, {
        workspace: seed.workspace, project: seed.project, runsTable,
        agent, parent, user: seed.user,
        provider: 'anthropic',
        kind: 'agent.run.failed',
        errorReason: 'budget_exceeded',
        seq: 9_100_001 + i,
      });
    }

    const result = await checkProviderHealth({
      workspaceId: seed.workspace.id,
      provider: 'anthropic',
      threshold: 3,
    });
    // Insufficient signal (0 provider-relevant events) → healthy.
    expect(result.next.status).toBe('healthy');
    expect(result.next.consecutive_failures).toBe(0);
  });

  // D-9.1 / mitigation 64 — 'tool_error' (model couldn't self-correct after
  // N consecutive recoverable tool errors) is a MODEL-recovery failure, not a
  // provider signal. The allow-list SQL filter
  // (`kind='agent.run.completed' OR error_reason='provider_error'`) excludes
  // it automatically. This pins the contract: if a future change flips the
  // filter to an exclude-list, this test fails before tool_error can silently
  // start degrading providers on model-recovery failures.
  test('tool_error failures do NOT count toward provider degradation', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    // 3 tool_error failures (≥ threshold) — none are provider signals.
    for (let i = 0; i < 3; i++) {
      await seedTerminalRunEvent(db, {
        workspace: seed.workspace, project: seed.project, runsTable,
        agent, parent, user: seed.user,
        provider: 'anthropic',
        kind: 'agent.run.failed',
        errorReason: 'tool_error',
        seq: 9_200_001 + i,
      });
    }

    const result = await checkProviderHealth({
      workspaceId: seed.workspace.id,
      provider: 'anthropic',
      threshold: 3,
    });
    // Insufficient signal (0 provider-relevant events) → healthy, NOT degraded.
    expect(result.next.status).toBe('healthy');
    expect(result.next.consecutive_failures).toBe(0);
  });

  test('next is healthy when the most recent event is a successful completion', async () => {
    // Mitigation 45 — a single success breaks the streak. Resets to
    // healthy even if older events in the window were failures.
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    // Order (newest last): fail, fail, fail, completed
    for (let i = 0; i < 3; i++) {
      await seedTerminalRunEvent(db, {
        workspace: seed.workspace, project: seed.project, runsTable,
        agent, parent, user: seed.user,
        provider: 'anthropic',
        kind: 'agent.run.failed',
        errorReason: 'provider_error',
        seq: 7_200_001 + i,
      });
    }
    await seedTerminalRunEvent(db, {
      workspace: seed.workspace, project: seed.project, runsTable,
      agent, parent, user: seed.user,
      provider: 'anthropic',
      kind: 'agent.run.completed',
      seq: 7_200_004,
    });

    const result = await checkProviderHealth({
      workspaceId: seed.workspace.id,
      provider: 'anthropic',
      threshold: 3,
    });
    expect(result.next.status).toBe('healthy');
  });

  // R4 regression — events older than `windowMs` are excluded. An idle
  // workspace can't stay locked in stale degraded state; F7's
  // per-recovery flush can't fire a spurious recovered against an
  // empty window.
  test('events older than the recency window are excluded (windowMs)', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    // 3 stale provider_error events (≥30 days ago).
    const staleMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 3; i++) {
      await seedTerminalRunEvent(db, {
        workspace: seed.workspace, project: seed.project, runsTable,
        agent, parent, user: seed.user,
        provider: 'anthropic',
        kind: 'agent.run.failed',
        errorReason: 'provider_error',
        seq: 9_500_001 + i,
        createdAtMs: staleMs + i,
      });
    }

    // With a 24h window, all 3 events drop → insufficient signal → healthy(0).
    const result = await checkProviderHealth({
      workspaceId: seed.workspace.id,
      provider: 'anthropic',
      threshold: 3,
      windowMs: 24 * 60 * 60 * 1000,
    });
    expect(result.next.status).toBe('healthy');
    expect(result.next.consecutive_failures).toBe(0);

    // With a long enough window (60 days), the same events count → degraded.
    const longWindow = await checkProviderHealth({
      workspaceId: seed.workspace.id,
      provider: 'anthropic',
      threshold: 3,
      windowMs: 60 * 24 * 60 * 60 * 1000,
    });
    expect(longWindow.next.status).toBe('degraded');
    expect(longWindow.next.consecutive_failures).toBe(3);
  });
});

// ---------- getProviderHealth ----------

describe('getProviderHealth', () => {
  test('returns all 4 providers with sensible defaults when no state is persisted', async () => {
    const { db, seed } = await makeTestApp();

    const result = await getProviderHealth({ workspaceId: seed.workspace.id });
    expect(result).toEqual({
      anthropic: { status: 'healthy', consecutive_failures: 0 },
      openai:    { status: 'healthy', consecutive_failures: 0 },
      openrouter:{ status: 'healthy', consecutive_failures: 0 },
      ollama:    { status: 'healthy', consecutive_failures: 0 },
    });
  });

  test('returns persisted state for a provider that has been written to', async () => {
    const { db, seed } = await makeTestApp();

    // Persist anthropic at degraded; openai stays at the default.
    await db.update(workspaces).set({
      providerHealth: {
        anthropic: { status: 'degraded', consecutive_failures: 5 },
      },
    }).where(eq(workspaces.id, seed.workspace.id));

    const result = await getProviderHealth({ workspaceId: seed.workspace.id });
    expect(result.anthropic).toEqual({ status: 'degraded', consecutive_failures: 5 });
    expect(result.openai).toEqual({ status: 'healthy', consecutive_failures: 0 });
  });
});

// ---------- maybeEmitProviderHealthEdge (tested through transitionRun) ----------

describe('transitionRun → maybeEmitProviderHealthEdge', () => {
  test('emits workspace.provider.degraded exactly once on tipping edge', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    // Pre-seed 2 prior provider_error failures (just under threshold=3).
    for (let i = 0; i < 2; i++) {
      await seedTerminalRunEvent(db, {
        workspace: seed.workspace, project: seed.project, runsTable,
        agent, parent, user: seed.user,
        provider: 'anthropic',
        kind: 'agent.run.failed',
        errorReason: 'provider_error',
        seq: 8_000_001 + i,
      });
    }

    // Now transition a fresh run to failed/provider_error — the 3rd failure.
    // This should trip the edge (healthy → degraded) and emit exactly once.
    const created = await createRun({
      workspace: seed.workspace,
      project: seed.project,
      runsTable,
      agent,
      actor: seed.user,
      input: {
        parentDocumentId: parent.id,
        firedBy: 'agent.task.assigned',
        chainId: crypto.randomUUID(),
        triggerId: null,
      },
    });
    await transitionRun(created.document.id, { newStatus: 'running', actor: seed.user.id });
    await transitionRun(created.document.id, {
      newStatus: 'failed',
      actor: seed.user.id,
      errorReason: 'provider_error',
    });

    const degradedEvents = await db.query.events.findMany({
      where: eq(events.kind, 'workspace.provider.degraded'),
    });
    expect(degradedEvents.length).toBe(1);
    expect((degradedEvents[0]!.payload as { provider: string }).provider).toBe('anthropic');
    // F4 — workspace.provider.* events are workspace-scoped per
    // event-bus.ts BUG-021. projectId MUST be null so cross-project
    // SSE subscribers receive the event.
    expect(degradedEvents[0]!.projectId).toBeNull();

    // Persisted state reflects degraded.
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, seed.workspace.id) });
    expect(ws!.providerHealth.anthropic?.status).toBe('degraded');
  });

  test('a 4th consecutive failure does NOT emit a second degraded event (continued state)', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    // Pre-seed 3 failures + persisted degraded state.
    for (let i = 0; i < 3; i++) {
      await seedTerminalRunEvent(db, {
        workspace: seed.workspace, project: seed.project, runsTable,
        agent, parent, user: seed.user,
        provider: 'anthropic',
        kind: 'agent.run.failed',
        errorReason: 'provider_error',
        seq: 8_100_001 + i,
      });
    }
    await db.update(workspaces).set({
      providerHealth: { anthropic: { status: 'degraded', consecutive_failures: 3 } },
    }).where(eq(workspaces.id, seed.workspace.id));

    // 4th failure — still degraded, no new edge to emit.
    const created = await createRun({
      workspace: seed.workspace,
      project: seed.project,
      runsTable,
      agent,
      actor: seed.user,
      input: {
        parentDocumentId: parent.id,
        firedBy: 'agent.task.assigned',
        chainId: crypto.randomUUID(),
        triggerId: null,
      },
    });
    await transitionRun(created.document.id, { newStatus: 'running', actor: seed.user.id });
    await transitionRun(created.document.id, {
      newStatus: 'failed',
      actor: seed.user.id,
      errorReason: 'provider_error',
    });

    const degradedEvents = await db.query.events.findMany({
      where: eq(events.kind, 'workspace.provider.degraded'),
    });
    expect(degradedEvents.length).toBe(0);

    // F11 follow-up — `consecutive_failures` stays at threshold (3)
    // on the 4th continued failure. This is by design: the SQL filter
    // LIMITs the window to `threshold` rows, so the algorithm has no
    // signal beyond threshold. Dashboards should read this as
    // "threshold+ consecutive failures", NOT a live counter.
    const ws = await db.query.workspaces.findFirst({
      where: eq(workspaces.id, seed.workspace.id),
    });
    expect(ws!.providerHealth.anthropic?.status).toBe('degraded');
    expect(ws!.providerHealth.anthropic?.consecutive_failures).toBe(3);
  });

  test('emits workspace.provider.recovered exactly once on recovery edge', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    // Pre-seed degraded persisted state + 3 prior failures.
    for (let i = 0; i < 3; i++) {
      await seedTerminalRunEvent(db, {
        workspace: seed.workspace, project: seed.project, runsTable,
        agent, parent, user: seed.user,
        provider: 'anthropic',
        kind: 'agent.run.failed',
        errorReason: 'provider_error',
        seq: 8_200_001 + i,
      });
    }
    await db.update(workspaces).set({
      providerHealth: { anthropic: { status: 'degraded', consecutive_failures: 3 } },
    }).where(eq(workspaces.id, seed.workspace.id));

    // A successful completion — degraded → healthy.
    const created = await createRun({
      workspace: seed.workspace,
      project: seed.project,
      runsTable,
      agent,
      actor: seed.user,
      input: {
        parentDocumentId: parent.id,
        firedBy: 'agent.task.assigned',
        chainId: crypto.randomUUID(),
        triggerId: null,
      },
    });
    await transitionRun(created.document.id, { newStatus: 'running', actor: seed.user.id });
    await transitionRun(created.document.id, { newStatus: 'completed', actor: seed.user.id });

    const recoveredEvents = await db.query.events.findMany({
      where: eq(events.kind, 'workspace.provider.recovered'),
    });
    expect(recoveredEvents.length).toBe(1);
    expect((recoveredEvents[0]!.payload as { provider: string }).provider).toBe('anthropic');
    // F4 — workspace-scoped: projectId is null so cross-project SSE
    // subscribers receive the recovery signal.
    expect(recoveredEvents[0]!.projectId).toBeNull();

    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, seed.workspace.id) });
    expect(ws!.providerHealth.anthropic?.status).toBe('healthy');
  });

  test('uses provider from run frontmatter, not current agent state (mitigation 46)', async () => {
    // The agent's `provider` could be edited mid-window — the run snapshots
    // its provider at create time. The emitted edge event MUST carry the
    // run's recorded provider, not the agent's current value.
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    // 2 prior failures on anthropic (the run's recorded provider).
    for (let i = 0; i < 2; i++) {
      await seedTerminalRunEvent(db, {
        workspace: seed.workspace, project: seed.project, runsTable,
        agent, parent, user: seed.user,
        provider: 'anthropic',
        kind: 'agent.run.failed',
        errorReason: 'provider_error',
        seq: 8_300_001 + i,
      });
    }

    // Create a run while the agent IS anthropic (snapshots provider into fm).
    const created = await createRun({
      workspace: seed.workspace,
      project: seed.project,
      runsTable,
      agent,
      actor: seed.user,
      input: {
        parentDocumentId: parent.id,
        firedBy: 'agent.task.assigned',
        chainId: crypto.randomUUID(),
        triggerId: null,
      },
    });

    // Now FLIP the agent's frontmatter.provider to openai mid-window — as
    // if an operator edited it. The run's recorded provider stays anthropic.
    await db.update(documents).set({
      frontmatter: sql`json_set(${documents.frontmatter}, '$.provider', 'openai')`,
    }).where(eq(documents.id, agent.id));

    await transitionRun(created.document.id, { newStatus: 'running', actor: seed.user.id });
    await transitionRun(created.document.id, {
      newStatus: 'failed',
      actor: seed.user.id,
      errorReason: 'provider_error',
    });

    const degradedEvents = await db.query.events.findMany({
      where: eq(events.kind, 'workspace.provider.degraded'),
    });
    expect(degradedEvents.length).toBe(1);
    // Mitigation 46 — recorded provider, not current agent state.
    expect((degradedEvents[0]!.payload as { provider: string }).provider).toBe('anthropic');
  });

  test('keeps SSE delivery fire-and-forget — slow subscriber does not block transition (mitigation 47)', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    // Register a subscriber whose async handler returns a promise that
    // never resolves. The bus calls the handler synchronously + discards
    // the return value (event-bus.ts:65) — even if a subscriber kicks off
    // long async work, the publisher does NOT await it.
    const { eventBus } = await import('../lib/event-bus.ts');
    const unsubscribe = eventBus.subscribe(seed.workspace.id, undefined, () => {
      // Async handler that never resolves — proxy for a slow SSE writer.
      return new Promise(() => { /* never resolves */ }) as unknown as void;
    });

    const created = await createRun({
      workspace: seed.workspace,
      project: seed.project,
      runsTable,
      agent,
      actor: seed.user,
      input: {
        parentDocumentId: parent.id,
        firedBy: 'agent.task.assigned',
        chainId: crypto.randomUUID(),
        triggerId: null,
      },
    });
    await transitionRun(created.document.id, { newStatus: 'running', actor: seed.user.id });

    const startMs = performance.now();
    await transitionRun(created.document.id, { newStatus: 'completed', actor: seed.user.id });
    const elapsedMs = performance.now() - startMs;

    unsubscribe();

    // Must complete fast — the never-resolving subscriber is fire-and-
    // forgotten. 200ms gives plenty of headroom for SQLite + JSON
    // serialization without blessing a regression.
    expect(elapsedMs).toBeLessThan(200);
  });
});

// ---------- ensureRunsTable ----------

describe('ensureRunsTable', () => {
  test('creates a runs table on first call with 6 statuses + 3 views + 11 events', async () => {
    const { db, seed } = await makeTestApp();

    const created = await db.transaction(async (tx) =>
      ensureRunsTable(tx, { workspaceId: seed.workspace.id, projectId: seed.project.id }),
    );
    expect(created.slug).toBe('runs');
    expect(created.projectId).toBe(seed.project.id);
    expect(typeof created.id).toBe('string');

    // Six statuses covering the run state machine.
    const statusRows = await db.query.statuses.findMany({
      where: eq(statuses.tableId, created.id),
    });
    const keys = statusRows.map((s) => s.key).sort();
    expect(keys).toEqual([
      'awaiting_approval',
      'completed',
      'failed',
      'planning',
      'rejected',
      'running',
    ]);

    // Three views: All / Failures / Awaiting approval.
    const viewRows = await db.query.views.findMany({
      where: eq(views.tableId, created.id),
    });
    expect(viewRows.length).toBe(3);
    const viewNames = viewRows.map((v) => v.name).sort();
    expect(viewNames).toEqual(['All runs', 'Awaiting approval', 'Failures']);

    // 11 lifecycle events: 1 table.created + 6 status.created + 3 view.created
    // + 1 runs_table.lazy_seeded.
    const lifecycleEvents = await db.query.events.findMany({
      where: (e, { inArray, and: andOp, eq: eqOp }) =>
        andOp(
          eqOp(e.workspaceId, seed.workspace.id),
          inArray(e.kind, [
            'table.created',
            'status.created',
            'view.created',
            'runs_table.lazy_seeded',
          ]),
        ),
    });
    const byKind = lifecycleEvents.reduce<Record<string, number>>((acc, e) => {
      acc[e.kind] = (acc[e.kind] ?? 0) + 1;
      return acc;
    }, {});
    expect(byKind['table.created']).toBe(1);
    expect(byKind['status.created']).toBe(6);
    expect(byKind['view.created']).toBe(3);
    expect(byKind['runs_table.lazy_seeded']).toBe(1);
  });

  test('is idempotent: second call returns the same table id and emits zero new events', async () => {
    // Mitigation 23 (verified inherited) — re-running ensureRunsTable on a
    // project where it already seeded MUST be a no-op. The runner calls
    // it once per run, and getting duplicate tables / statuses / views
    // or a second `runs_table.lazy_seeded` event would corrupt the UI
    // (rail leaves doubled) and the event log.
    const { db, seed } = await makeTestApp();

    const first = await db.transaction(async (tx) =>
      ensureRunsTable(tx, { workspaceId: seed.workspace.id, projectId: seed.project.id }),
    );

    // Snapshot event count after first seed.
    const eventsAfterFirst = await db.query.events.findMany({
      where: (e, { eq: eqOp }) => eqOp(e.workspaceId, seed.workspace.id),
    });
    const firstCount = eventsAfterFirst.length;

    const second = await db.transaction(async (tx) =>
      ensureRunsTable(tx, { workspaceId: seed.workspace.id, projectId: seed.project.id }),
    );
    expect(second.id).toBe(first.id);

    // No additional events on the idempotent path.
    const eventsAfterSecond = await db.query.events.findMany({
      where: (e, { eq: eqOp }) => eqOp(e.workspaceId, seed.workspace.id),
    });
    expect(eventsAfterSecond.length).toBe(firstCount);

    // Still exactly 6 statuses + 3 views — no duplicates from re-seeding.
    const statusRows = await db.query.statuses.findMany({
      where: eq(statuses.tableId, first.id),
    });
    expect(statusRows.length).toBe(6);
    const viewRows = await db.query.views.findMany({
      where: eq(views.tableId, first.id),
    });
    expect(viewRows.length).toBe(3);
  });

  test('emits runs_table.lazy_seeded exactly once on create with workspace + project scope', async () => {
    // The runner's frontend subscribers listen for this event to refresh
    // the rail (a new `Runs` leaf appears under the project). The scope
    // fields are what filter the SSE delivery — project subscribers in
    // the right project see it; everyone else doesn't.
    const { db, seed } = await makeTestApp();

    await db.transaction(async (tx) =>
      ensureRunsTable(tx, { workspaceId: seed.workspace.id, projectId: seed.project.id }),
    );

    const seededEvents = await db.query.events.findMany({
      where: eq(events.kind, 'runs_table.lazy_seeded'),
    });
    expect(seededEvents.length).toBe(1);
    expect(seededEvents[0]!.workspaceId).toBe(seed.workspace.id);
    expect(seededEvents[0]!.projectId).toBe(seed.project.id);
    const payload = seededEvents[0]!.payload as { table_id?: string; slug?: string };
    expect(payload.slug).toBe('runs');
    expect(typeof payload.table_id).toBe('string');
  });

  // F14 regression — two concurrent first-callers in distinct
  // transactions must converge to the SAME table id and emit the
  // event suite EXACTLY ONCE total. Pre-F14, the loser hit the
  // unique-index violation and its outer tx rolled back; post-F14,
  // ON CONFLICT DO NOTHING + post-INSERT re-fetch makes the loser a
  // no-op.
  test('two concurrent callers converge on the same table id (race, no duplicate events)', async () => {
    const { db, seed } = await makeTestApp();

    const [a, b] = await Promise.all([
      db.transaction(async (tx) =>
        ensureRunsTable(tx, { workspaceId: seed.workspace.id, projectId: seed.project.id }),
      ),
      db.transaction(async (tx) =>
        ensureRunsTable(tx, { workspaceId: seed.workspace.id, projectId: seed.project.id }),
      ),
    ]);
    expect(a.id).toBe(b.id);

    // Exactly one set of lifecycle events — the loser did not re-emit.
    const lifecycleEvents = await db.query.events.findMany({
      where: (e, { eq: eqOp, and: andOp, inArray }) =>
        andOp(
          eqOp(e.workspaceId, seed.workspace.id),
          inArray(e.kind, [
            'table.created',
            'status.created',
            'view.created',
            'runs_table.lazy_seeded',
          ]),
        ),
    });
    const byKind = lifecycleEvents.reduce<Record<string, number>>((acc, e) => {
      acc[e.kind] = (acc[e.kind] ?? 0) + 1;
      return acc;
    }, {});
    expect(byKind['table.created']).toBe(1);
    expect(byKind['status.created']).toBe(6);
    expect(byKind['view.created']).toBe(3);
    expect(byKind['runs_table.lazy_seeded']).toBe(1);
  });
});

// ---------- R11: worker_started_at Z-suffix CHECK ----------

describe('worker_started_at Z-suffix DB constraint (migration 0014)', () => {
  test('rejects an INSERT with non-Z worker_started_at on an agent_run row', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    const now = new Date().toISOString();
    let caught: Error | undefined;
    try {
      await db.insert(documents).values({
        id: nanoid(),
        workspaceId: seed.workspace.id,
        projectId: seed.project.id,
        tableId: runsTable.id,
        type: 'agent_run',
        slug: `helper-bad-${nanoid(6)}`,
        title: 'bad tz',
        status: 'running',
        body: '',
        frontmatter: {
          assignee: `agent:${agent.slug}`,
          status: 'running',
          agent_slug: agent.slug,
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          system_prompt: 'x',
          max_tokens: 1000,
          tokens_in: 0,
          tokens_out: 0,
          trigger_id: null,
          chain_id: crypto.randomUUID(),
          fired_by: 'manual',
          started_at: now,
          // Non-Z offset — the R11 trigger MUST reject this.
          worker_started_at: '2026-05-28T17:54:32.123+02:00',
        } as unknown as Record<string, unknown>,
        parentId: parent.id,
        createdBy: seed.user.id,
        updatedBy: seed.user.id,
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught!.message.toLowerCase()).toContain('worker_started_at');
  });

  test('accepts an INSERT with a Z-suffixed worker_started_at on an agent_run row', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    const created = await seedRunAt(
      db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'running',
      { workerStartedAt: new Date().toISOString() },
    );
    expect(created.id).toBeTruthy();
  });

  test('accepts NULL worker_started_at (planning + recovered rows)', async () => {
    const { db, seed } = await makeTestApp();
    const table = await getWorkItemsTable(db, seed.project.id);
    const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
    const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);

    // seedRunAt default has no worker_started_at — must pass.
    const created = await seedRunAt(
      db, seed.workspace, seed.project, runsTable, agent, parent, seed.user, 'planning',
    );
    expect(created.id).toBeTruthy();
  });
});

// ---------- nextChainId ----------

describe('nextChainId', () => {
  test('mints a new UUIDv4 when firedBy has no chain prefix', () => {
    const a = nextChainId({ firedBy: 'agent.task.assigned' });
    const b = nextChainId({ firedBy: 'manual' });
    // Both are valid UUIDv4s (4 in the 3rd group's first position).
    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(a).toMatch(uuidV4);
    expect(b).toMatch(uuidV4);
    // Distinct mints — randomness guard.
    expect(a).not.toBe(b);
  });

  test('extracts the UUID from firedBy when it carries a chain prefix', () => {
    const existing = 'b67e4f50-3acb-4d1f-9c63-9d1e8b3a2c4f';
    const result = nextChainId({ firedBy: `chain:${existing}:agent.task.assigned` });
    expect(result).toBe(existing);
  });

  test('mints fresh when firedBy looks like chain: but the UUID is malformed', () => {
    // Mitigation 29 — chain_id MUST be a valid UUID, no exceptions. A
    // mangled `chain:not-a-uuid:...` MUST NOT propagate; mint fresh instead.
    const result = nextChainId({ firedBy: 'chain:not-a-uuid:agent.task.assigned' });
    expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  test('result always satisfies agentRunFrontmatterSchema.chain_id (z.string().uuid())', () => {
    // Mitigation 29 lock — the helper's output is exactly what
    // createRun writes into frontmatter.chain_id. If the schema rejects
    // it, the runner can't create a chain-aggregated row. 50 mints to
    // catch a stray bad randomUUID + every supported firedBy shape.
    const inputs = [
      'agent.task.assigned',
      'manual',
      'comment.mentioned',
      'trigger:foo',
      'chain:7c9e6679-7425-40de-944b-e07fc1f90ae7:agent.task.assigned',
    ];
    for (let i = 0; i < 50; i++) {
      for (const firedBy of inputs) {
        const id = nextChainId({ firedBy });
        // Use the schema's own validator on a single field via .pick().
        const parsed = agentRunFrontmatterSchema.shape.chain_id.safeParse(id);
        expect(parsed.success).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// setRunBody
// ---------------------------------------------------------------------------

describe('setRunBody', () => {
  test('setRunBody writes the transcript to the run document body', async () => {
    const { db } = await makeTestApp();

    // Seed workspace + project using the standard project-defaults helper.
    const wsId = nanoid();
    await db.insert(workspaces).values({ id: wsId, name: 'test-ws', slug: `ws-${nanoid(6)}` });
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, wsId) });

    const userId = nanoid();
    await db.insert(users).values({ id: userId, email: `u-${nanoid(6)}@test.dev`, passwordHash: 'x', name: 'Tester' });
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });

    const projectId = nanoid();
    await db.insert(schemaProjects).values({ id: projectId, workspaceId: wsId, name: 'test-proj', slug: `p-${nanoid(6)}` });
    await seedProjectDefaults(db, projectId);
    const project = await db.query.projects.findFirst({ where: (p, { eq }) => eq(p.id, projectId) });

    const runsTable = await seedRunsTable(db, projectId);
    const agent = await seedAgent(db, ws!, user!, `agent-${nanoid(6)}`);
    const workItemsTable = await getWorkItemsTable(db, projectId);
    const parent = await seedWorkItem(db, ws!, project!, workItemsTable, user!);
    const run = await seedRunningRun(db, ws!, project!, runsTable, agent, parent, user!);

    await setRunBody(run.id, 'FULL TRANSCRIPT TEXT');

    const row = await db.query.documents.findFirst({ where: eq(documents.id, run.id) });
    expect(row!.body).toBe('FULL TRANSCRIPT TEXT');
  });

  test('setRunBody emits agent.run.transcript so the body write is never eventless (rule #4)', async () => {
    const { db } = await makeTestApp();

    const wsId = nanoid();
    await db.insert(workspaces).values({ id: wsId, name: 'test-ws', slug: `ws-${nanoid(6)}` });
    const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, wsId) });

    const userId = nanoid();
    await db.insert(users).values({ id: userId, email: `u-${nanoid(6)}@test.dev`, passwordHash: 'x', name: 'Tester' });
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });

    const projectId = nanoid();
    await db.insert(schemaProjects).values({ id: projectId, workspaceId: wsId, name: 'test-proj', slug: `p-${nanoid(6)}` });
    await seedProjectDefaults(db, projectId);
    const project = await db.query.projects.findFirst({ where: (p, { eq }) => eq(p.id, projectId) });

    const runsTable = await seedRunsTable(db, projectId);
    const agent = await seedAgent(db, ws!, user!, `agent-${nanoid(6)}`);
    const workItemsTable = await getWorkItemsTable(db, projectId);
    const parent = await seedWorkItem(db, ws!, project!, workItemsTable, user!);
    const run = await seedRunningRun(db, ws!, project!, runsTable, agent, parent, user!);

    await setRunBody(run.id, 'TRANSCRIPT WITH EVENT');

    const transcriptEvents = await db.query.events.findMany({
      where: eq(events.kind, 'agent.run.transcript'),
    });
    expect(transcriptEvents.length).toBe(1);
    expect(transcriptEvents[0]!.documentId).toBe(run.id);
    expect(transcriptEvents[0]!.workspaceId).toBe(wsId);
    expect(transcriptEvents[0]!.projectId).toBe(projectId);
  });
});
