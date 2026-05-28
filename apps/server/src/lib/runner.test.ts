/**
 * Phase 3 Sub-phase C.2 — Task C-8: runAgent core-loop tests.
 *
 * The provider wire is mocked via `__INTERNAL_TEST_ONLY__.overrideRegistry`
 * (see [[mock-the-wire-not-the-response]]) so the real SDK stream is never
 * hit; the stub's `stream()` is an async generator yielding scripted
 * ProviderEvents. Both module-global registries (provider + agent-tools) are
 * reset in afterEach (see [[mock-module-leaks-across-bun-tests]]).
 */

import { test, expect, describe, afterEach } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { makeTestApp } from '../test/harness.ts';
import {
  aiKeys,
  apiTokens,
  documents,
  tables,
  type Document,
  type Project,
  type TableEntity,
  type User,
  type Workspace,
} from '../db/schema.ts';
import { newApiToken } from './auth.ts';
import { toolsToScopes } from './agent-schema.ts';
import { encryptSecret } from './crypto.ts';
import type { AgentRunFrontmatter } from './agent-run-schema.ts';
import type { AIProvider, ProviderEvent } from './ai/provider.ts';
import { __INTERNAL_TEST_ONLY__ as providerTestHatch } from './ai/provider.ts';
import { createComment } from '../services/comments.ts';
import { runAgent } from './runner.ts';

type TestDB = Awaited<ReturnType<typeof makeTestApp>>['db'];

// --------------------------------------------------------------------------
// Teardown — unwind both module-global registries between tests.
// --------------------------------------------------------------------------

const toolRegistry = (
  globalThis as unknown as { __folioToolRegistry?: Map<string, unknown> }
).__folioToolRegistry;
const registeredTools: string[] = [];

afterEach(() => {
  providerTestHatch.reset();
  for (const name of registeredTools) toolRegistry?.delete(name);
  registeredTools.length = 0;
});

// --------------------------------------------------------------------------
// Provider stub helpers — script a sequence of events, assert non-invocation.
// --------------------------------------------------------------------------

interface StubControl {
  /** Set by the test: queues of events; each queue is one stream() round. */
  rounds: ProviderEvent[][];
  /** Incremented every time stream() is pulled. */
  called: number;
}

function installProviderStub(control: StubControl): void {
  const stub: AIProvider = {
    async *stream() {
      const round = control.rounds[control.called] ?? [];
      control.called++;
      for (const ev of round) yield ev;
    },
    async testKey() {
      return { ok: true as const };
    },
  };
  providerTestHatch.overrideRegistry('anthropic', async () => stub);
}

// --------------------------------------------------------------------------
// Seeding
// --------------------------------------------------------------------------

async function getWorkItemsTable(db: TestDB, projectId: string): Promise<TableEntity> {
  const t = await db.query.tables.findFirst({
    where: and(eq(tables.projectId, projectId), eq(tables.slug, 'work-items')),
  });
  if (!t) throw new Error('test setup: work-items table missing');
  return t;
}

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
  body = 'Do the thing.',
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
    body,
    frontmatter: {},
    createdBy: user.id,
    updatedBy: user.id,
  });
  return (await db.query.documents.findFirst({ where: eq(documents.id, id) }))!;
}

async function seedAgent(
  db: TestDB,
  workspace: Workspace,
  user: User,
  slug: string,
  tools: string[] = ['list_documents'],
  overrides: Record<string, unknown> = {},
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
      tools,
      projects: ['*'],
      max_delegation_depth: 2,
      max_tokens_per_run: 12_345,
      requires_approval: false,
      api_token_id: apiTokenId,
      ...overrides,
    },
    createdBy: user.id,
    updatedBy: user.id,
  });
  await db.insert(apiTokens).values({
    id: apiTokenId,
    workspaceId: workspace.id,
    name: `agent:${slug}`,
    tokenHash: hash,
    // documents:read covers __echo; tests that need a strict tool register it
    // directly and rely on the same scope.
    scopes: [...new Set([...toolsToScopes(tools), 'documents:read'])],
    agentId: id,
    createdBy: user.id,
  });
  return (await db.query.documents.findFirst({ where: eq(documents.id, id) }))!;
}

async function seedAiKey(db: TestDB, workspaceId: string): Promise<void> {
  await db.insert(aiKeys).values({
    id: nanoid(),
    workspaceId,
    provider: 'anthropic',
    label: 'default',
    encryptedKey: encryptSecret('sk-test-fake-key'),
  });
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
  return (await db.query.documents.findFirst({ where: eq(documents.id, id) }))!;
}

/** Full happy-path scaffold: ai key + agent + parent + running run. */
async function scaffold(
  opts: {
    tools?: string[];
    agentOverrides?: Record<string, unknown>;
    runOverrides?: Partial<AgentRunFrontmatter>;
    withAiKey?: boolean;
    parentBody?: string;
  } = {},
): Promise<{
  db: TestDB;
  workspace: Workspace;
  project: Project;
  user: User;
  agent: Document;
  parent: Document;
  run: Document;
}> {
  const { db, seed } = await makeTestApp();
  if (opts.withAiKey !== false) await seedAiKey(db, seed.workspace.id);
  const wiTable = await getWorkItemsTable(db, seed.project.id);
  const runsTable = await seedRunsTable(db, seed.project.id);
  const agent = await seedAgent(db, seed.workspace, seed.user, 'helper', opts.tools, opts.agentOverrides);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, wiTable, seed.user, opts.parentBody);
  const run = await seedRunningRun(
    db,
    seed.workspace,
    seed.project,
    runsTable,
    agent,
    parent,
    seed.user,
    opts.runOverrides,
  );
  return {
    db,
    workspace: seed.workspace,
    project: seed.project,
    user: seed.user,
    agent,
    parent,
    run,
  };
}

async function readRun(db: TestDB, runId: string): Promise<AgentRunFrontmatter> {
  const row = await db.query.documents.findFirst({
    where: and(eq(documents.id, runId), eq(documents.type, 'agent_run')),
  });
  // frontmatter.status mirrors the column in lockstep (mitigation 40).
  return row!.frontmatter as AgentRunFrontmatter;
}

async function listKind(db: TestDB, parentId: string, kind: string): Promise<Document[]> {
  return db.query.documents.findMany({
    where: and(eq(documents.parentId, parentId), eq(documents.type, 'comment')),
  }).then((rows) =>
    rows.filter((r) => (r.frontmatter as Record<string, unknown>).kind === kind),
  );
}

// ==========================================================================
// Step 1/2 — pre-flight checks
// ==========================================================================

describe('runAgent pre-flight checks', () => {
  test('no_ai_key — fails when no ai_keys row for the provider, stream never called', async () => {
    const { db, run, parent } = await scaffold({ withAiKey: false });
    const control: StubControl = { rounds: [], called: 0 };
    installProviderStub(control);

    await runAgent({ runId: run.id });

    const fm = await readRun(db, run.id);
    expect(fm.status).toBe('failed');
    expect(fm.error_reason).toBe('no_ai_key');
    expect(control.called).toBe(0);
    expect(parent.id).toBeTruthy();
  });

  test('depth_exceeded — chain of 4 runs with max_delegation_depth=2 blocks', async () => {
    const { db, workspace, project, user, agent, parent, run } = await scaffold({
      agentOverrides: { max_delegation_depth: 2 },
    });
    const control: StubControl = { rounds: [], called: 0 };
    installProviderStub(control);

    // Seed 3 sibling runs on the SAME chain_id → total chain length 4 > 2.
    const runsTable = await db.query.tables.findFirst({
      where: and(eq(tables.projectId, project.id), eq(tables.slug, 'runs')),
    });
    const chainId = (await readRun(db, run.id)).chain_id;
    for (let i = 0; i < 3; i++) {
      await seedRunningRun(db, workspace, project, runsTable!, agent, parent, user, {
        chain_id: chainId,
        status: 'completed',
      });
    }

    await runAgent({ runId: run.id });

    const fm = await readRun(db, run.id);
    expect(fm.status).toBe('failed');
    expect(fm.error_reason).toBe('depth_exceeded');
    expect(control.called).toBe(0);
  });

  test('rate_limited — workspace cap of 0 blocks', async () => {
    process.env.FOLIO_MAX_RUNS_PER_HOUR_PER_WORKSPACE = '0';
    const { db, run } = await scaffold();
    const control: StubControl = { rounds: [], called: 0 };
    installProviderStub(control);

    await runAgent({ runId: run.id });
    delete process.env.FOLIO_MAX_RUNS_PER_HOUR_PER_WORKSPACE;

    const fm = await readRun(db, run.id);
    expect(fm.status).toBe('failed');
    expect(fm.error_reason).toBe('rate_limited');
    expect(control.called).toBe(0);
  });

  test('chain_guard — fanout cap of 0 blocks with fanout_exceeded', async () => {
    process.env.FOLIO_MAX_CHAIN_FANOUT = '0';
    const { db, run } = await scaffold();
    const control: StubControl = { rounds: [], called: 0 };
    installProviderStub(control);

    await runAgent({ runId: run.id });
    delete process.env.FOLIO_MAX_CHAIN_FANOUT;

    const fm = await readRun(db, run.id);
    expect(fm.status).toBe('failed');
    expect(fm.error_reason).toBe('fanout_exceeded');
    expect(control.called).toBe(0);
  });

  test('idempotency_violation — a sibling run already active on the parent blocks', async () => {
    const { db, workspace, project, user, agent, parent, run } = await scaffold();
    const control: StubControl = { rounds: [], called: 0 };
    installProviderStub(control);

    const runsTable = await db.query.tables.findFirst({
      where: and(eq(tables.projectId, project.id), eq(tables.slug, 'runs')),
    });
    // A sibling at status=running for same parent + agent slug. Stamp it with a
    // clearly-later createdAt so getActiveRun (orderBy createdAt DESC) returns
    // the sibling, not the run-under-test (avoids a same-ms tie).
    const sibling = await seedRunningRun(db, workspace, project, runsTable!, agent, parent, user, {
      status: 'running',
    });
    await db
      .update(documents)
      .set({ createdAt: new Date(Date.now() + 60_000) })
      .where(eq(documents.id, sibling.id));

    await runAgent({ runId: run.id });

    const fm = await readRun(db, run.id);
    expect(fm.status).toBe('failed');
    expect(fm.error_reason).toBe('idempotency_violation');
    expect(control.called).toBe(0);
  });

  test('provider_error — degraded provider health blocks', async () => {
    process.env.FOLIO_PROVIDER_DEGRADE_THRESHOLD = '1';
    const { db, workspace, project, user, agent, parent, run } = await scaffold();
    const control: StubControl = { rounds: [], called: 0 };
    installProviderStub(control);

    // Seed prior provider_error failed events so checkProviderHealth derives
    // degraded. Default threshold is 3 — seed 3 failed runs + emit events.
    const { transitionRun } = await import('../services/agent-runs.ts');
    const { txWithEvents } = await import('./events.ts');
    const runsTable = await db.query.tables.findFirst({
      where: and(eq(tables.projectId, project.id), eq(tables.slug, 'runs')),
    });
    for (let i = 0; i < 3; i++) {
      const prior = await seedRunningRun(db, workspace, project, runsTable!, agent, parent, user, {
        status: 'running',
        chain_id: crypto.randomUUID(),
      });
      await txWithEvents(db, async () => {
        await transitionRun(prior.id, {
          newStatus: 'failed',
          actor: user.id,
          errorReason: 'provider_error',
          errorDetail: 'boom',
        });
      });
    }
    delete process.env.FOLIO_PROVIDER_DEGRADE_THRESHOLD;

    await runAgent({ runId: run.id });

    const fm = await readRun(db, run.id);
    expect(fm.status).toBe('failed');
    expect(fm.error_reason).toBe('provider_error');
    expect(control.called).toBe(0);
  });
});

// ==========================================================================
// Step 3/4 — stream loop
// ==========================================================================

describe('runAgent stream loop', () => {
  test('completed-on-done writes a kind=result comment', async () => {
    const { db, run, parent } = await scaffold();
    const control: StubControl = {
      rounds: [
        [
          { type: 'text', delta: 'Hello ' },
          { type: 'text', delta: 'world.' },
          { type: 'tokens', tokens_in: 10, tokens_out: 5 },
          { type: 'done', reason: 'stop' },
        ],
      ],
      called: 0,
    };
    installProviderStub(control);

    await runAgent({ runId: run.id });

    const fm = await readRun(db, run.id);
    expect(fm.status).toBe('completed');
    const results = await listKind(db, parent.id, 'result');
    expect(results.length).toBe(1);
    expect(results[0]!.body).toBe('Hello world.');
  });

  test('increments tokens — sum of 3 token events', async () => {
    const { db, run } = await scaffold();
    const control: StubControl = {
      rounds: [
        [
          { type: 'tokens', tokens_in: 10, tokens_out: 5 },
          { type: 'tokens', tokens_in: 3, tokens_out: 2 },
          { type: 'tokens', tokens_in: 1, tokens_out: 1 },
          { type: 'text', delta: 'done' },
          { type: 'done', reason: 'stop' },
        ],
      ],
      called: 0,
    };
    installProviderStub(control);

    await runAgent({ runId: run.id });

    const fm = await readRun(db, run.id);
    expect(fm.tokens_in).toBe(14);
    expect(fm.tokens_out).toBe(8);
    expect(fm.status).toBe('completed');
  });

  test('budget_exceeded — tokens crossing max_tokens fails + partial comment + aborts', async () => {
    const { db, run, parent } = await scaffold({ runOverrides: { max_tokens: 10 } });
    let pulledAfterBudget = false;
    const control: StubControl = {
      rounds: [
        [
          { type: 'tokens', tokens_in: 8, tokens_out: 5 }, // 13 > 10
          // The runner should break here; if it keeps pulling it would see this:
          { type: 'text', delta: 'should-not-accumulate' },
          { type: 'done', reason: 'stop' },
        ],
      ],
      called: 0,
    };
    // Wrap the generator to detect post-budget pulls.
    const stub: AIProvider = {
      async *stream() {
        control.called++;
        yield { type: 'tokens', tokens_in: 8, tokens_out: 5 } as ProviderEvent;
        pulledAfterBudget = true;
        yield { type: 'text', delta: 'should-not-accumulate' } as ProviderEvent;
        yield { type: 'done', reason: 'stop' } as ProviderEvent;
      },
      async testKey() {
        return { ok: true as const };
      },
    };
    providerTestHatch.overrideRegistry('anthropic', async () => stub);

    await runAgent({ runId: run.id });

    const fm = await readRun(db, run.id);
    expect(fm.status).toBe('failed');
    expect(fm.error_reason).toBe('budget_exceeded');
    const comments = await listKind(db, parent.id, 'comment');
    expect(comments.length).toBe(1);
    expect(comments[0]!.body).toContain('Budget cap exceeded');
    // The runner broke out of the for-await after the budget event, so the
    // generator was never pulled again — proving the stream was aborted.
    expect(pulledAfterBudget).toBe(false);
    const results = await listKind(db, parent.id, 'result');
    expect(results.length).toBe(0);
  });

  test('tool_call dispatched via executeTool and result fed back', async () => {
    const { db, run, parent } = await scaffold({ tools: ['list_documents'] });
    // Register a throwaway echo tool requiring documents:read.
    const { registerTool } = await import('./agent-tools.ts');
    const toolName = `__test_echo_${nanoid(6)}`;
    registerTool({
      name: toolName,
      requiredScope: 'documents:read',
      schema: z.object({ value: z.string() }).strict(),
      handler: async (args: { value: string }) => ({ echoed: args.value }),
    });
    registeredTools.push(toolName);

    const stub: AIProvider = {
      async *stream(opts) {
        // Round 1 → emit a tool_call. Round 2 (after the runner feeds the
        // result back) → emit text + stop. Distinguish by message count.
        const hasToolResult = opts.messages.some((m) => m.role === 'tool');
        if (!hasToolResult) {
          yield { type: 'tool_call', id: 'tc-1', name: toolName, arguments: { value: 'hi' } } as ProviderEvent;
          yield { type: 'tokens', tokens_in: 5, tokens_out: 5 } as ProviderEvent;
          yield { type: 'done', reason: 'tool_use' } as ProviderEvent;
        } else {
          // Verify the tool result was fed back.
          const toolMsg = opts.messages.find((m) => m.role === 'tool');
          expect(toolMsg!.content).toContain('echoed');
          yield { type: 'text', delta: 'final answer' } as ProviderEvent;
          yield { type: 'done', reason: 'stop' } as ProviderEvent;
        }
      },
      async testKey() {
        return { ok: true as const };
      },
    };
    providerTestHatch.overrideRegistry('anthropic', async () => stub);

    await runAgent({ runId: run.id });

    const fm = await readRun(db, run.id);
    expect(fm.status).toBe('completed');
    const results = await listKind(db, parent.id, 'result');
    expect(results[0]!.body).toBe('final answer');
  });

  test('mcp_invalid_args — bad args fail with paths-only detail', async () => {
    const { db, run } = await scaffold({ tools: ['list_documents'] });
    const { registerTool } = await import('./agent-tools.ts');
    const toolName = `__test_strict_${nanoid(6)}`;
    registerTool({
      name: toolName,
      requiredScope: 'documents:read',
      schema: z.object({ value: z.string() }).strict(),
      handler: async () => ({ ok: true }),
    });
    registeredTools.push(toolName);

    const stub: AIProvider = {
      async *stream() {
        yield { type: 'tool_call', id: 'tc-1', name: toolName, arguments: { value: 123 } } as ProviderEvent;
        yield { type: 'done', reason: 'tool_use' } as ProviderEvent;
      },
      async testKey() {
        return { ok: true as const };
      },
    };
    providerTestHatch.overrideRegistry('anthropic', async () => stub);

    await runAgent({ runId: run.id });

    const fm = await readRun(db, run.id);
    expect(fm.status).toBe('failed');
    expect(fm.error_reason).toBe('provider_error');
    // transitionRun collapses any bare-string errorDetail through
    // sanitizeProviderError (closed whitelist), so the persisted detail never
    // carries the rejected arg value (mitigation 26/28). The runner passes the
    // paths-only issues array; the sanitizer drops it to the safe constant.
    expect(fm.error_detail).not.toContain('123');
  });

  test('mcp_tool_error — tool throws, detail is sanitized (no verbatim leak)', async () => {
    const { db, run } = await scaffold({ tools: ['list_documents'] });
    const { registerTool } = await import('./agent-tools.ts');
    const toolName = `__test_boom_${nanoid(6)}`;
    registerTool({
      name: toolName,
      requiredScope: 'documents:read',
      schema: z.object({}).strict(),
      handler: async () => {
        const e = new Error('boom sk-secret-leak') as Error & { status: number };
        e.status = 500;
        throw e;
      },
    });
    registeredTools.push(toolName);

    const stub: AIProvider = {
      async *stream() {
        yield { type: 'tool_call', id: 'tc-1', name: toolName, arguments: {} } as ProviderEvent;
        yield { type: 'done', reason: 'tool_use' } as ProviderEvent;
      },
      async testKey() {
        return { ok: true as const };
      },
    };
    providerTestHatch.overrideRegistry('anthropic', async () => stub);

    await runAgent({ runId: run.id });

    const fm = await readRun(db, run.id);
    expect(fm.status).toBe('failed');
    expect(fm.error_reason).toBe('provider_error');
    // The secret must never survive into error_detail. transitionRun's
    // closed-whitelist sanitizer guarantees this even though the runner
    // pre-sanitizes (defense in depth).
    expect(fm.error_detail).not.toContain('sk-secret-leak');
    expect(fm.error_detail).not.toContain('boom');
  });

  test('cancel_via_comment — post-start rejection comment cancels + posts partial', async () => {
    const { db, workspace, project, run, parent } = await scaffold();

    const userRow = await db.query.users.findFirst({});

    const stub: AIProvider = {
      async *stream() {
        // Emit a tool_call so the cancel check (which runs before tool exec)
        // fires. We need a registered tool to avoid method-not-found — but the
        // cancel check short-circuits BEFORE executeTool, so any name works.
        yield { type: 'tool_call', id: 'tc-1', name: '__echo', arguments: { value: 'x' } } as ProviderEvent;
        yield { type: 'done', reason: 'tool_use' } as ProviderEvent;
      },
      async testKey() {
        return { ok: true as const };
      },
    };
    providerTestHatch.overrideRegistry('anthropic', async () => stub);

    // Seed a rejection comment AFTER started_at.
    const { workspaces } = await import('../db/schema.ts');
    const fullWs = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspace.id) });
    await createComment({
      workspace: fullWs!,
      project,
      parent,
      authorContext: { type: 'user', userId: userRow!.id },
      actor: userRow!.id,
      body: 'stop @helper',
      kind: 'rejection',
      targetAgent: 'helper',
    });

    await runAgent({ runId: run.id });

    const fm = await readRun(db, run.id);
    expect(fm.status).toBe('failed');
    expect(fm.error_reason).toBe('cancelled');
    const comments = await listKind(db, parent.id, 'comment');
    const cancelMsg = comments.find((c) => c.body.includes('Cancelled by user'));
    expect(cancelMsg).toBeTruthy();
  });

  test('done_reason persisted — refusal terminates as completed', async () => {
    const { db, run } = await scaffold();
    const control: StubControl = {
      rounds: [
        [
          { type: 'text', delta: 'I cannot help with that.' },
          { type: 'done', reason: 'refusal' },
        ],
      ],
      called: 0,
    };
    installProviderStub(control);

    await runAgent({ runId: run.id });

    const fm = await readRun(db, run.id);
    expect(fm.done_reason).toBe('refusal');
    expect(fm.status).toBe('completed');
  });
});

// ==========================================================================
// Step 5 — top-level catch
// ==========================================================================

describe('runAgent top-level containment', () => {
  test('transitions failed when the stream throws unexpectedly', async () => {
    const { db, run } = await scaffold();
    const stub: AIProvider = {
      // biome-ignore lint/correctness/useYield: intentional throw before yield
      async *stream() {
        throw new Error('unexpected provider explosion');
      },
      async testKey() {
        return { ok: true as const };
      },
    };
    providerTestHatch.overrideRegistry('anthropic', async () => stub);

    // Must not throw out of runAgent.
    await runAgent({ runId: run.id });

    const fm = await readRun(db, run.id);
    expect(fm.status).toBe('failed');
    expect(fm.error_reason).toBe('provider_error');
  });
});
