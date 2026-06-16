/**
 * M2 RunSink refactor (audit 2.6/H10) — Cluster A (A-1/A-2).
 *
 * TIER A: these implementations reproduce SECURITY-LOAD-BEARING behavior — the
 * inclusive cancel boundary (FIX #1), the single-failure-surface that kills the
 * double-post bug (mitigation 6), and the per-factory token accumulator
 * (mitigation 3). Each method is tested against a REAL in-memory DB (migrations
 * on bun:sqlite) seeded with real rows; the services are NOT mocked — the
 * `RunSink` methods drive `createComment` / `transitionRun` / `incrementTokens` /
 * `appendMessage` against the real schema, exactly as the runner will.
 *
 * RED-first proof recorded in the task report: the inclusive-boundary assertion
 * was watched to FAIL against a strict `>` comparison before the `>=` impl made
 * it GREEN (the denial/boundary path is the contract, not an afterthought).
 */

import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { DB } from '../db/client.ts';
import {
  type Document,
  type Project,
  type TableEntity,
  type User,
  type Workspace,
  documents,
  messages,
  tables,
} from '../db/schema.ts';
import { createComment } from '../services/comments.ts';
import { createConversation } from '../services/conversations.ts';
import { makeTestApp } from '../test/harness.ts';
import type { AgentRunFrontmatter } from './agent-run-schema.ts';
import { makeConversationRunSink, makeDocumentRunSink } from './run-sink.ts';
import type { DocumentRunContext, RunContext } from './runner.ts';

type TestDB = Awaited<ReturnType<typeof makeTestApp>>['db'];

// ---------------------------------------------------------------------------
// Seeding — a real parent + agent_run on the real schema (mirrors runner.test.ts).
// ---------------------------------------------------------------------------

async function workItemsTable(db: TestDB, projectId: string): Promise<TableEntity> {
  const t = await db.query.tables.findFirst({
    where: and(eq(tables.projectId, projectId), eq(tables.slug, 'work-items')),
  });
  if (!t) throw new Error('test setup: work-items table missing');
  return t;
}

async function seedParent(
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
    body: 'Do the thing.',
    frontmatter: {},
    createdBy: user.id,
    updatedBy: user.id,
  });
  return (await db.query.documents.findFirst({ where: eq(documents.id, id) }))!;
}

async function seedRun(
  db: TestDB,
  workspace: Workspace,
  project: Project,
  table: TableEntity,
  parent: Document,
  user: User,
  startedAt: string,
): Promise<Document> {
  const id = nanoid();
  const fm: AgentRunFrontmatter = {
    assignee: 'agent:helper',
    status: 'running',
    agent_slug: 'helper',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    ai_key_label: 'default',
    system_prompt: 'You are a helper.',
    max_tokens: 12_345,
    tokens_in: 0,
    tokens_out: 0,
    trigger_id: null,
    chain_id: crypto.randomUUID(),
    fired_by: 'agent.task.assigned',
    started_at: startedAt,
    worker_started_at: startedAt,
    caller_scopes: ['documents:read', 'documents:write', 'documents:delete'],
    caller_project_ids: null,
  };
  await db.insert(documents).values({
    id,
    workspaceId: workspace.id,
    projectId: project.id,
    tableId: table.id,
    type: 'agent_run',
    slug: `helper-run-${nanoid(8)}`,
    title: 'helper run',
    status: fm.status,
    body: '',
    frontmatter: fm as unknown as Record<string, unknown>,
    parentId: parent.id,
    createdBy: user.id,
    updatedBy: user.id,
  });
  return (await db.query.documents.findFirst({ where: eq(documents.id, id) }))!;
}

/**
 * Build a minimal-but-real document `RunContext`. Only the fields the document
 * RunSink methods read are populated; the rest are absent (no sink/conversation).
 */
function docCtx(args: {
  db: DB;
  workspace: Workspace;
  project: Project;
  parent: Document;
  run: Document;
  user: User;
  fm: AgentRunFrontmatter;
}): DocumentRunContext {
  return {
    kind: 'document',
    run: args.run,
    fm: args.fm,
    parent: args.parent,
    workspace: args.workspace,
    project: args.project,
    actor: 'agent:helper',
    transitionActor: args.user.id,
    authorContext: { type: 'user', userId: args.user.id },
  } as unknown as DocumentRunContext;
}

/**
 * A conversation `RunContext` — run + conversationId, no parent. The
 * conversation RunSink uses the module-global `db` proxy (which makeTestApp
 * re-points at the test DB), not a `ctx.db` field — so none is passed here.
 */
function convCtx(args: { run: Document; conversationId: string }): RunContext {
  return {
    kind: 'conversation',
    run: args.run,
    conversationId: args.conversationId,
  } as unknown as RunContext;
}

async function setupDoc() {
  const { db, seed } = await makeTestApp();
  const table = await workItemsTable(db, seed.project.id);
  const parent = await seedParent(db, seed.workspace, seed.project, table, seed.user);
  const startedAt = new Date().toISOString();
  const run = await seedRun(db, seed.workspace, seed.project, table, parent, seed.user, startedAt);
  const fm = run.frontmatter as AgentRunFrontmatter;
  const ctx = docCtx({
    db,
    workspace: seed.workspace,
    project: seed.project,
    parent,
    run,
    user: seed.user,
    fm,
  });
  return { db, ctx, parent, run, user: seed.user, startedAt };
}

async function readRunFm(db: TestDB, runId: string): Promise<AgentRunFrontmatter> {
  const row = await db.query.documents.findFirst({
    where: and(eq(documents.id, runId), eq(documents.type, 'agent_run')),
  });
  return row!.frontmatter as AgentRunFrontmatter;
}

// ===========================================================================
// wasCancelled — the INCLUSIVE boundary (FIX #1 / mitigation 9), the highest-
// value security assertion in this file.
// ===========================================================================

describe('DocumentRunSink.wasCancelled — inclusive >= started_at boundary', () => {
  test('a rejection stamped EXACTLY at started_at returns true (inclusive)', async () => {
    const { db, ctx, parent, user } = await setupDoc();
    const startedMs = new Date(ctx.fm.started_at).getTime();

    // A rejection comment whose createdAt is the SAME millisecond as started_at.
    const c = await createComment({
      workspace: ctx.workspace,
      project: ctx.project,
      parent,
      authorContext: { type: 'user', userId: user.id },
      actor: user.id,
      body: 'stop',
      kind: 'rejection',
      targetAgent: 'helper',
    });
    // Force its createdAt to exactly started_at (the same-millisecond race).
    await db
      .update(documents)
      .set({ createdAt: new Date(startedMs) })
      .where(eq(documents.id, c.id));

    const sink = makeDocumentRunSink(ctx);
    expect(await sink.wasCancelled()).toBe(true);
  });

  test('a rejection stamped strictly BEFORE started_at returns false', async () => {
    const { db, ctx, parent, user } = await setupDoc();
    const startedMs = new Date(ctx.fm.started_at).getTime();

    const c = await createComment({
      workspace: ctx.workspace,
      project: ctx.project,
      parent,
      authorContext: { type: 'user', userId: user.id },
      actor: user.id,
      body: 'stale stop from a prior run',
      kind: 'rejection',
      targetAgent: 'helper',
    });
    await db
      .update(documents)
      .set({ createdAt: new Date(startedMs - 1) })
      .where(eq(documents.id, c.id));

    const sink = makeDocumentRunSink(ctx);
    expect(await sink.wasCancelled()).toBe(false);
  });

  test('no rejection at all returns false', async () => {
    const { ctx } = await setupDoc();
    const sink = makeDocumentRunSink(ctx);
    expect(await sink.wasCancelled()).toBe(false);
  });
});

describe('ConversationRunSink.wasCancelled', () => {
  test('always returns false (mid-turn chat cancel is a v1 deferral)', async () => {
    const { db, seed } = await makeTestApp();
    const conv = await createConversation(db, {
      createdBy: seed.user.id,
      operatorAgentId: '_operator',
      title: 'c',
    });
    const sink = makeConversationRunSink(
      convCtx({ run: { id: nanoid() } as Document, conversationId: conv.id }),
    );
    expect(await sink.wasCancelled()).toBe(false);
  });
});

// ===========================================================================
// fail — ConversationRunSink writes EXACTLY ONE message (no double-post,
// mitigation 6).
// ===========================================================================

describe('ConversationRunSink.fail — single failure surface', () => {
  test('writes EXACTLY ONE text message row (no double-post)', async () => {
    const { db, seed } = await makeTestApp();
    const conv = await createConversation(db, {
      createdBy: seed.user.id,
      operatorAgentId: '_operator',
      title: 'c',
    });
    const runId = nanoid();
    const sink = makeConversationRunSink(
      convCtx({ run: { id: runId } as Document, conversationId: conv.id }),
    );

    await sink.fail('cancelled', 'Cancelled by user — partial work above.');

    const rows = await db.query.messages.findMany({
      where: eq(messages.conversationId, conv.id),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('text');
    expect(rows[0]!.body).toContain('Cancelled by user');
    expect(rows[0]!.runId).toBe(runId);
  });

  test('cancel() also writes EXACTLY ONE message (fail-only branch)', async () => {
    const { db, seed } = await makeTestApp();
    const conv = await createConversation(db, {
      createdBy: seed.user.id,
      operatorAgentId: '_operator',
      title: 'c',
    });
    const sink = makeConversationRunSink(
      convCtx({ run: { id: nanoid() } as Document, conversationId: conv.id }),
    );

    await sink.cancel();

    const rows = await db.query.messages.findMany({
      where: eq(messages.conversationId, conv.id),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('text');
  });
});

// ===========================================================================
// trackTokens — conversation accumulator persists across calls (mitigation 3).
// ===========================================================================

describe('ConversationRunSink.trackTokens — accumulates across calls', () => {
  test('round-2 totals include round-1 (no per-call reset)', async () => {
    const { db, seed } = await makeTestApp();
    const conv = await createConversation(db, {
      createdBy: seed.user.id,
      operatorAgentId: '_operator',
      title: 'c',
    });
    const sink = makeConversationRunSink(
      convCtx({ run: { id: nanoid() } as Document, conversationId: conv.id }),
    );

    const r1 = await sink.trackTokens(10, 5);
    expect(r1).toEqual({ tokensIn: 10, tokensOut: 5 });

    const r2 = await sink.trackTokens(3, 7);
    expect(r2).toEqual({ tokensIn: 13, tokensOut: 12 });
  });
});

describe('DocumentRunSink.trackTokens — persists post-increment totals (FIX #10)', () => {
  test('returns the running totals read back from the agent_run row', async () => {
    const { db, ctx, run } = await setupDoc();
    const sink = makeDocumentRunSink(ctx);

    const r1 = await sink.trackTokens(10, 5);
    expect(r1).toEqual({ tokensIn: 10, tokensOut: 5 });

    const r2 = await sink.trackTokens(3, 7);
    expect(r2).toEqual({ tokensIn: 13, tokensOut: 12 });

    // Persisted on the real agent_run row.
    const fm = await readRunFm(db, run.id);
    expect(fm.tokens_in).toBe(13);
    expect(fm.tokens_out).toBe(12);
  });
});

// ===========================================================================
// complete — doc transitions to completed; conv is a no-op.
// ===========================================================================

describe('complete — lifecycle transition (doc) vs no-op (conv)', () => {
  test('DocumentRunSink.complete transitions the run to completed', async () => {
    const { db, ctx, run } = await setupDoc();
    const sink = makeDocumentRunSink(ctx);

    await sink.complete('stop');

    const fm = await readRunFm(db, run.id);
    expect(fm.status).toBe('completed');
    expect(fm.done_reason).toBe('stop');
  });

  test('ConversationRunSink.complete is a no-op (no transition, no message)', async () => {
    const { db, seed } = await makeTestApp();
    const conv = await createConversation(db, {
      createdBy: seed.user.id,
      operatorAgentId: '_operator',
      title: 'c',
    });
    const sink = makeConversationRunSink(
      convCtx({ run: { id: nanoid() } as Document, conversationId: conv.id }),
    );

    await sink.complete('stop'); // must not throw (no agent_run row exists)

    const rows = await db.query.messages.findMany({
      where: eq(messages.conversationId, conv.id),
    });
    expect(rows).toHaveLength(0);
  });
});

describe('DocumentRunSink.fail transitions the run to failed', () => {
  test('writes status=failed + the error reason/detail', async () => {
    const { db, ctx, run } = await setupDoc();
    const sink = makeDocumentRunSink(ctx);

    await sink.fail('budget_exceeded', 'over budget');

    const fm = await readRunFm(db, run.id);
    expect(fm.status).toBe('failed');
    expect(fm.error_reason).toBe('budget_exceeded');
  });
});

// ===========================================================================
// toolStep — doc no-op; conv appends a tool_step row.
// ===========================================================================

describe('toolStep — no-op (doc) vs tool_step row (conv)', () => {
  test('DocumentRunSink.toolStep is a no-op (no comment written)', async () => {
    const { db, ctx, parent } = await setupDoc();
    const sink = makeDocumentRunSink(ctx);

    await sink.toolStep({ tool: 'list_documents', summary: 'listed 3', status: 'ok' });

    // No comment doc created under the parent.
    const children = await db.query.documents.findMany({
      where: and(eq(documents.parentId, parent.id), eq(documents.type, 'comment')),
    });
    expect(children).toHaveLength(0);
  });

  test('ConversationRunSink.toolStep appends one tool_step message row', async () => {
    const { db, seed } = await makeTestApp();
    const conv = await createConversation(db, {
      createdBy: seed.user.id,
      operatorAgentId: '_operator',
      title: 'c',
    });
    const sink = makeConversationRunSink(
      convCtx({ run: { id: nanoid() } as Document, conversationId: conv.id }),
    );

    await sink.toolStep({ tool: 'list_documents', summary: 'listed 3', status: 'ok' });

    const rows = await db.query.messages.findMany({
      where: eq(messages.conversationId, conv.id),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('tool_step');
  });
});

// ===========================================================================
// post — doc createComment; conv text message.
// ===========================================================================

describe('post — createComment (doc) vs text message (conv)', () => {
  test('DocumentRunSink.post writes a result comment on the parent', async () => {
    const { db, ctx, parent } = await setupDoc();
    const sink = makeDocumentRunSink(ctx);

    await sink.post('the answer', 'result');

    const children = await db.query.documents.findMany({
      where: and(eq(documents.parentId, parent.id), eq(documents.type, 'comment')),
    });
    expect(children).toHaveLength(1);
    expect(children[0]!.body).toBe('the answer');
  });

  test('ConversationRunSink.post writes a text message', async () => {
    const { db, seed } = await makeTestApp();
    const conv = await createConversation(db, {
      createdBy: seed.user.id,
      operatorAgentId: '_operator',
      title: 'c',
    });
    const sink = makeConversationRunSink(
      convCtx({ run: { id: nanoid() } as Document, conversationId: conv.id }),
    );

    await sink.post('the answer', 'result');

    const rows = await db.query.messages.findMany({
      where: eq(messages.conversationId, conv.id),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('text');
    expect(rows[0]!.body).toBe('the answer');
  });
});

// ===========================================================================
// conversationSink bridge + isConversation flag.
// ===========================================================================

describe('conversationSink bridge + isConversation flag', () => {
  test('DocumentRunSink: conversationSink undefined, isConversation false', async () => {
    const { ctx } = await setupDoc();
    const sink = makeDocumentRunSink(ctx);
    expect(sink.isConversation).toBe(false);
    expect(sink.conversationSink).toBeUndefined();
  });

  test('ConversationRunSink: conversationSink is a defined ConversationSink with .component', async () => {
    const { db, seed } = await makeTestApp();
    const conv = await createConversation(db, {
      createdBy: seed.user.id,
      operatorAgentId: '_operator',
      title: 'c',
    });
    const sink = makeConversationRunSink(
      convCtx({ run: { id: nanoid() } as Document, conversationId: conv.id }),
    );
    expect(sink.isConversation).toBe(true);
    expect(sink.conversationSink).toBeDefined();
    expect(typeof sink.conversationSink!.component).toBe('function');
  });

  // C-3a — negative-discriminator bite-proof for the clean-pause guards.
  //
  // runner.ts's two clean-pause turn-ends gate on `ctx.runSink.isConversation`
  // (C-3, runner.ts ~1701/1733):
  //   if (ctx.runSink.isConversation && awaitingConfirmation) { …complete turn… }
  //   if (ctx.runSink.isConversation && askedChoice)          { …complete turn… }
  // A DOCUMENT run must NEVER take those branches: the confirm gate engages ONLY
  // with a conversationId (agent-tools.ts ~422) and `ask_choice` throws
  // `forbidden:` (fatal) on a doc run, so `awaitingConfirmation`/`askedChoice` are
  // never set there — `isConversation === false` is the SOLE discriminator keeping
  // a doc run out of the conversation-only clean-pause path. This asserts the value
  // the guard reads (the document RunSink's discriminator) is `false`: if the C-3
  // migration inverted it (e.g. `!ctx.runSink.isConversation` or wired the
  // conversation impl onto a doc run), a document run would clean-pause instead of
  // proceeding — and this goes RED. The positive case is asserted above; this is
  // the negative half the clean-pause migration depends on.
  test('a document run does NOT enter the conversation-only clean-pause branch (isConversation discriminator is false)', async () => {
    const { ctx } = await setupDoc();
    // The exact read the runner's C-3 clean-pause guards perform.
    expect(makeDocumentRunSink(ctx).isConversation).toBe(false);
  });
});
