/**
 * Service-level tests for the agent-runs service (Phase 3 Sub-phase C.1).
 *
 * Bypasses HTTP; calls the service functions directly against an in-memory
 * SQLite via the standard test harness.
 */

import { test, expect, describe } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { makeTestApp } from '../test/harness.ts';
import {
  apiTokens,
  documents,
  events,
  tables,
  users,
  type Document,
  type Project,
  type TableEntity,
  type User,
  type Workspace,
} from '../db/schema.ts';
import { newApiToken } from '../lib/auth.ts';
import { toolsToScopes } from '../lib/agent-schema.ts';
import type { AgentRunFrontmatter } from '../lib/agent-run-schema.ts';
import { HTTPError } from '../lib/http.ts';
import { sanitizeProviderError } from '../lib/ai/sanitize-error.ts';
import { createRun, transitionRun, incrementTokens } from './agent-runs.ts';

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
