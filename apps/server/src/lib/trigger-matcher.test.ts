/**
 * Phase 3 Sub-phase C.3 (Task C-11) — trigger-matcher reactor tests.
 *
 * The trigger-matcher is the FIRST reactor on the Reaction Plane. It reads
 * trigger DOCUMENTS (`type='trigger'`) and honors them: when a human assigns or
 * @-mentions an agent, it durably creates a `planning` agent_run. Matching
 * logic lives in the trigger documents (data), not in hard-coded reactor code.
 *
 * Three invariants pinned here:
 *  - mitigation 50 — agent allow-list (`frontmatter.projects`) gates the create.
 *  - mitigation 51 — the autonomy gate: with FOLIO_AGENT_CHAINS_ENABLED OFF
 *    (default), an agent-ORIGINATED event creates ZERO runs + one
 *    `agent.chain.suppressed` signal; human-originated events still fire.
 *  - mitigation 52 — idempotency: a non-terminal peer run for (parent, agent)
 *    short-circuits the create (also the dispatcher's at-least-once safety net).
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
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
import { eventBus } from './event-bus.ts';
import type { BusEvent } from './event-bus.ts';
import { triggerMatcher } from './trigger-matcher.ts';

type TestDB = Awaited<ReturnType<typeof makeTestApp>>['db'];

afterEach(() => eventBus.__clear());

// ----- seed helpers (mirrored from services/agent-runs.test.ts) -----

async function getWorkItemsTable(db: TestDB, projectId: string): Promise<TableEntity> {
  const t = await db.query.tables.findFirst({
    where: and(eq(tables.projectId, projectId), eq(tables.slug, 'work-items')),
  });
  if (!t) throw new Error('test setup: work-items table missing');
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
  const slug = `wi-${nanoid(6)}`;
  await db.insert(documents).values({
    id,
    workspaceId: workspace.id,
    projectId: project.id,
    tableId: table.id,
    type: 'work_item',
    slug,
    title: 'Parent WI',
    status: null,
    body: '',
    frontmatter: {},
    createdBy: user.id,
    updatedBy: user.id,
  });
  const row = await db.query.documents.findFirst({ where: eq(documents.id, id) });
  if (!row) throw new Error('test setup: work_item insert did not round-trip');
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
    body: '',
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
  if (!row) throw new Error('test setup: agent insert did not round-trip');
  return row;
}

async function seedTriggers(db: TestDB, workspaceId: string, actorId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await seedBuiltinTriggers(tx, workspaceId, actorId);
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
): Promise<void> {
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insert(documents).values({
    id,
    workspaceId: workspace.id,
    projectId: project.id,
    tableId: runsTable.id,
    type: 'agent_run',
    slug: `${agent.slug}-${now.replace(/:/g, '-')}-${nanoid(8)}`,
    title: `${agent.slug} run`,
    status: 'running',
    body: '',
    frontmatter: {
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
    },
    parentId: parent.id,
    createdBy: user.id,
    updatedBy: user.id,
  });
}

async function countRuns(db: TestDB, parentId: string, agentSlug: string): Promise<number> {
  const rows = await db.query.documents.findMany({
    where: and(
      eq(documents.type, 'agent_run'),
      eq(documents.parentId, parentId),
      sql`json_extract(${documents.frontmatter}, '$.agent_slug') = ${agentSlug}`,
    ),
  });
  return rows.length;
}

function assignmentEvent(args: {
  seed: TestSeed;
  workItem: Document;
  agentSlug: string;
  agentId: string;
  actor: string;
}): BusEvent & { seq: number } {
  return {
    id: `ev-${nanoid(6)}`,
    workspaceId: args.seed.workspace.id,
    projectId: args.seed.project.id,
    documentId: args.workItem.id, // assignment: documentId IS the parent work_item
    kind: 'agent.task.assigned',
    actor: args.actor,
    payload: { slug: args.workItem.slug, agent: args.agentSlug, agent_id: args.agentId },
    createdAt: Date.now(),
    seq: 1,
  };
}

function mentionEvent(args: {
  seed: TestSeed;
  parentId: string;
  agentSlug: string;
  agentId: string;
  actor: string;
  runId?: string;
}): BusEvent & { seq: number } {
  return {
    id: `ev-${nanoid(6)}`,
    workspaceId: args.seed.workspace.id,
    projectId: args.seed.project.id,
    documentId: `comment-${nanoid(6)}`, // mention: documentId is the COMMENT, NOT the parent
    kind: 'comment.mentioned',
    actor: args.actor,
    payload: {
      comment_id: `comment-${nanoid(6)}`,
      parent_id: args.parentId, // THE PARENT lives here for comment.* events
      agent_id: args.agentId,
      agent_slug: args.agentSlug,
      ...(args.runId ? { run_id: args.runId } : {}),
    },
    createdAt: Date.now(),
    seq: 1,
  };
}

// ----- Step 3: create-path (allow-list + idempotency) -----

test('creates one planning agent_run for a human assignment matching builtin-on-assignment', async () => {
  const { db, seed } = await makeTestApp();
  await seedTriggers(db, seed.workspace.id, seed.user.id);
  const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
  const wiTable = await getWorkItemsTable(db, seed.project.id);
  const wi = await seedWorkItem(db, seed.workspace, seed.project, wiTable, seed.user);

  await triggerMatcher.react(
    assignmentEvent({
      seed,
      workItem: wi,
      agentSlug: 'helper',
      agentId: agent.id,
      actor: seed.user.id,
    }),
  );

  expect(await countRuns(db, wi.id, 'helper')).toBe(1);
  const run = await db.query.documents.findFirst({
    where: and(eq(documents.type, 'agent_run'), eq(documents.parentId, wi.id)),
  });
  expect(run?.status).toBe('planning');
  expect(run?.createdBy).toBe(seed.user.id); // owned by the originating human
});

test('does NOT create a run when the agent allow-list excludes the project (mitigation 50)', async () => {
  const { db, seed } = await makeTestApp();
  await seedTriggers(db, seed.workspace.id, seed.user.id);
  // allow-list names a different project id → this project is excluded.
  const agent = await seedAgent(db, seed.workspace, seed.user, 'helper', ['some-other-project-id']);
  const wiTable = await getWorkItemsTable(db, seed.project.id);
  const wi = await seedWorkItem(db, seed.workspace, seed.project, wiTable, seed.user);

  await triggerMatcher.react(
    assignmentEvent({
      seed,
      workItem: wi,
      agentSlug: 'helper',
      agentId: agent.id,
      actor: seed.user.id,
    }),
  );

  expect(await countRuns(db, wi.id, 'helper')).toBe(0);
});

test('does NOT create a duplicate when getActiveRun returns a non-terminal peer (mitigation 52)', async () => {
  const { db, seed } = await makeTestApp();
  await seedTriggers(db, seed.workspace.id, seed.user.id);
  const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
  const wiTable = await getWorkItemsTable(db, seed.project.id);
  const wi = await seedWorkItem(db, seed.workspace, seed.project, wiTable, seed.user);
  // ensure a runs table exists so we can pre-seed a running peer.
  const runsTable = await db.transaction(async (tx) => {
    const { ensureRunsTable } = await import('../services/agent-runs.ts');
    return ensureRunsTable(tx, { workspaceId: seed.workspace.id, projectId: seed.project.id });
  });
  await seedRunningRun(db, seed.workspace, seed.project, runsTable, agent, wi, seed.user);
  expect(await countRuns(db, wi.id, 'helper')).toBe(1);

  await triggerMatcher.react(
    assignmentEvent({
      seed,
      workItem: wi,
      agentSlug: 'helper',
      agentId: agent.id,
      actor: seed.user.id,
    }),
  );

  expect(await countRuns(db, wi.id, 'helper')).toBe(1); // no second row
});

// ----- Step 5: the autonomy gate (mitigation 51) — the V1↔autonomous pin -----
//
// Flag toggling: the matcher reads `env.FOLIO_AGENT_CHAINS_ENABLED` (parsed
// once at import). To exercise the ON path we mutate the parsed value in-place
// and restore it in afterEach. This is the documented, simplest approach; the
// alternative (an indirection seam) buys nothing here since only these tests
// flip it.

const flagKey = 'FOLIO_AGENT_CHAINS_ENABLED' as const;
let savedFlag: boolean;
beforeEach(() => {
  savedFlag = (env as Record<string, unknown>)[flagKey] as boolean;
});
afterEach(() => {
  (env as Record<string, unknown>)[flagKey] = savedFlag;
});

test('flag OFF + agent-originated @mention → ZERO runs + one agent.chain.suppressed', async () => {
  const { db, seed } = await makeTestApp();
  (env as Record<string, unknown>)[flagKey] = false; // explicit; default is also false
  await seedTriggers(db, seed.workspace.id, seed.user.id);
  const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
  const wiTable = await getWorkItemsTable(db, seed.project.id);
  const wi = await seedWorkItem(db, seed.workspace, seed.project, wiTable, seed.user);

  const suppressed: string[] = [];
  const unsub = eventBus.subscribe(seed.workspace.id, undefined, (e) => {
    if (e.kind === 'agent.chain.suppressed') suppressed.push(e.kind);
  });
  // actor = 'agent:foo' → agent-originated
  await triggerMatcher.react(
    mentionEvent({
      seed,
      parentId: wi.id,
      agentSlug: 'helper',
      agentId: agent.id,
      actor: 'agent:foo',
    }),
  );
  unsub();

  expect(await countRuns(db, wi.id, 'helper')).toBe(0);
  expect(suppressed.length).toBe(1);
});

test('flag OFF + human @mention → exactly one run, no suppressed event', async () => {
  const { db, seed } = await makeTestApp();
  (env as Record<string, unknown>)[flagKey] = false;
  await seedTriggers(db, seed.workspace.id, seed.user.id);
  const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
  const wiTable = await getWorkItemsTable(db, seed.project.id);
  const wi = await seedWorkItem(db, seed.workspace, seed.project, wiTable, seed.user);

  const suppressed: string[] = [];
  const unsub = eventBus.subscribe(seed.workspace.id, undefined, (e) => {
    if (e.kind === 'agent.chain.suppressed') suppressed.push(e.kind);
  });
  await triggerMatcher.react(
    mentionEvent({
      seed,
      parentId: wi.id,
      agentSlug: 'helper',
      agentId: agent.id,
      actor: seed.user.id,
    }),
  );
  unsub();

  expect(await countRuns(db, wi.id, 'helper')).toBe(1);
  expect(suppressed.length).toBe(0);
});

test('flag ON + agent-originated @mention → one run', async () => {
  const { db, seed } = await makeTestApp();
  (env as Record<string, unknown>)[flagKey] = true;
  await seedTriggers(db, seed.workspace.id, seed.user.id);
  const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
  const wiTable = await getWorkItemsTable(db, seed.project.id);
  const wi = await seedWorkItem(db, seed.workspace, seed.project, wiTable, seed.user);

  // Agent-originated marker WITHOUT an `agent:` actor: the event carries a
  // `payload.run_id` (isAgentOriginated true via that path) while `actor`
  // remains a resolvable human id so the run still has a real User owner.
  // This mirrors a real agent-chain hop: the originating human owns the chain;
  // the run_id is the upstream run that triggered this one.
  await triggerMatcher.react(
    mentionEvent({
      seed,
      parentId: wi.id,
      agentSlug: 'helper',
      agentId: agent.id,
      actor: seed.user.id,
      runId: 'upstream-run-id',
    }),
  );

  expect(await countRuns(db, wi.id, 'helper')).toBe(1);
});
