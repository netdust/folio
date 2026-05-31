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
    // The agent body IS the prompt (snapshot at run-create); createRun rejects
    // an empty body, so seed a non-empty one by default (override for the
    // empty-prompt skip test).
    body,
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

/**
 * Seed an `awaiting_approval` agent_run (adapted from seedRunningRun) so the
 * D-5 internal_action handlers (resume_run / reject_run) have a pending run to
 * act on. Returns the run id.
 */
async function seedAwaitingApprovalRun(
  db: TestDB,
  workspace: Workspace,
  project: Project,
  runsTable: TableEntity,
  agent: Document,
  parent: Document,
  user: User,
  chainId: string = crypto.randomUUID(),
): Promise<string> {
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
    status: 'awaiting_approval',
    body: '',
    frontmatter: {
      assignee: `agent:${agent.slug}`,
      status: 'awaiting_approval',
      agent_slug: agent.slug,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      system_prompt: 'You are a helper.',
      max_tokens: 12_345,
      tokens_in: 0,
      tokens_out: 0,
      trigger_id: null,
      chain_id: chainId,
      fired_by: 'agent.task.assigned',
      started_at: now,
      worker_started_at: now,
    },
    parentId: parent.id,
    createdBy: user.id,
    updatedBy: user.id,
  });
  return id;
}

/** A `comment.created` event carrying the C.3 payload (services/comments.ts). */
function commentCreatedEvent(args: {
  seed: TestSeed;
  parentId: string;
  agentSlug: string;
  kind: 'approval' | 'rejection';
  actor: string;
  commentId?: string;
  /**
   * Override the literal `target_agent` payload value. Defaults to
   * `args.agentSlug` (the bare slug). Pass `agent:<slug>` to exercise the
   * PREFIXED form that the cancel route + clients can emit (see
   * comments.ts "three forms" — Finding 1).
   */
  targetAgent?: string;
}): BusEvent & { seq: number } {
  const commentId = args.commentId ?? `comment-${nanoid(6)}`;
  return {
    id: `ev-${nanoid(6)}`,
    workspaceId: args.seed.workspace.id,
    projectId: args.seed.project.id,
    documentId: commentId, // comment.created: documentId IS the comment
    kind: 'comment.created',
    actor: args.actor,
    payload: {
      document_id: commentId,
      parent_id: args.parentId,
      author: args.actor,
      kind: args.kind,
      target_agent: args.targetAgent ?? args.agentSlug,
    },
    createdAt: Date.now(),
    seq: 1,
  };
}

async function ensureRunsTableFor(db: TestDB, seed: TestSeed): Promise<TableEntity> {
  return db.transaction(async (tx) => {
    const { ensureRunsTable } = await import('../services/agent-runs.ts');
    return ensureRunsTable(tx, { workspaceId: seed.workspace.id, projectId: seed.project.id });
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

test('a body-less (empty-prompt) agent is SKIPPED, not thrown — react() must not halt the reactor', async () => {
  // Regression: createRun throws AGENT_PROMPT_EMPTY for an empty-body agent. On
  // the reactor path that throw would escape react(), and the durable dispatcher
  // treats a throwing react() as a HALT (cursor not advanced → the same event
  // replays forever, wedging ALL trigger processing instance-wide). So react()
  // must SKIP the body-less agent (zero runs) and return normally, like the
  // other misconfiguration guards (unresolved agent/owner).
  const { db, seed } = await makeTestApp();
  await seedTriggers(db, seed.workspace.id, seed.user.id);
  // Empty body = no prompt.
  const agent = await seedAgent(db, seed.workspace, seed.user, 'no-prompt', undefined, '   ');
  const wiTable = await getWorkItemsTable(db, seed.project.id);
  const wi = await seedWorkItem(db, seed.workspace, seed.project, wiTable, seed.user);

  // Must NOT throw (a throw here = a halted reactor in production).
  await triggerMatcher.react(
    assignmentEvent({
      seed,
      workItem: wi,
      agentSlug: 'no-prompt',
      agentId: agent.id,
      actor: seed.user.id,
    }),
  );

  // Skipped: zero runs created (the run was not created, but the reactor lives).
  expect(await countRuns(db, wi.id, 'no-prompt')).toBe(0);
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

// ----- FIX 2: allow-list reuses resolveAgentProjects (mitigation 50 hardening) -----
//
// The matcher previously hand-rolled `(fm.projects as string[]) ?? ['*']` then
// `.includes('*')`. A hand-edited `.md` with a NON-ARRAY `projects` (a bare
// string) made `.includes()` do substring matching on the string — wrong
// allow-list semantics, and a non-string entry could throw. The canonical
// `resolveAgentProjects` guards `!Array.isArray → ['*']`, so a string
// `projects` becomes WILDCARD (the documented legacy/back-compat behavior),
// going through the exact same normalization as every other call site.
test('malformed projects (non-array string) is treated as wildcard via resolveAgentProjects (no substring match)', async () => {
  const { db, seed } = await makeTestApp();
  await seedTriggers(db, seed.workspace.id, seed.user.id);
  const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
  // Corrupt the agent frontmatter: projects is a STRING, not an array. With the
  // old hand-rolled cast this would substring-match; resolveAgentProjects
  // collapses it to ['*'] (legacy back-compat), so the run fires for ANY
  // project — including this one.
  await db
    .update(documents)
    .set({
      frontmatter: { ...(agent.frontmatter as Record<string, unknown>), projects: 'alpha' },
    })
    .where(eq(documents.id, agent.id));

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

  // resolveAgentProjects(non-array) === ['*'] → wildcard → run fires.
  expect(await countRuns(db, wi.id, 'helper')).toBe(1);
});

// ----- FIX 3: comment-mention run owner resolves token id → token creator -----
//
// A HUMAN posting a comment-mention via a personal API token (agentId NULL)
// has `event.actor = <api_tokens.id>` (resolveActor returns token.id on
// bearer), NOT a users.id. The matcher previously only did
// `users.findFirst({id: actor})` → null → dropped the run silently. The fix
// resolves a non-user actor as a human PAT and uses its `createdBy` as owner.
async function seedHumanPat(db: TestDB, workspace: Workspace, user: User): Promise<string> {
  const id = nanoid();
  const { hash } = newApiToken();
  await db.insert(apiTokens).values({
    id,
    workspaceId: workspace.id,
    name: 'human pat',
    tokenHash: hash,
    scopes: ['documents:write'],
    agentId: null, // human PAT
    createdBy: user.id,
  });
  return id;
}

test('comment.mentioned via a human PAT token id resolves owner to the token creator', async () => {
  const { db, seed } = await makeTestApp();
  await seedTriggers(db, seed.workspace.id, seed.user.id);
  const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
  const wiTable = await getWorkItemsTable(db, seed.project.id);
  const wi = await seedWorkItem(db, seed.workspace, seed.project, wiTable, seed.user);
  const patId = await seedHumanPat(db, seed.workspace, seed.user);

  // actor = the api_tokens.id (bearer path), NOT seed.user.id.
  await triggerMatcher.react(
    mentionEvent({
      seed,
      parentId: wi.id,
      agentSlug: 'helper',
      agentId: agent.id,
      actor: patId,
    }),
  );

  expect(await countRuns(db, wi.id, 'helper')).toBe(1);
  const run = await db.query.documents.findFirst({
    where: and(eq(documents.type, 'agent_run'), eq(documents.parentId, wi.id)),
  });
  expect(run?.status).toBe('planning');
  expect(run?.createdBy).toBe(seed.user.id); // owned by the token's human creator
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

// ----- D-5: resume_run / reject_run internal_actions (mitigations 43, 52) -----

test('reject_run transitions the awaiting_approval run to rejected', async () => {
  const { db, seed } = await makeTestApp();
  await seedTriggers(db, seed.workspace.id, seed.user.id);
  const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
  const wiTable = await getWorkItemsTable(db, seed.project.id);
  const wi = await seedWorkItem(db, seed.workspace, seed.project, wiTable, seed.user);
  const runsTable = await ensureRunsTableFor(db, seed);
  const runId = await seedAwaitingApprovalRun(
    db,
    seed.workspace,
    seed.project,
    runsTable,
    agent,
    wi,
    seed.user,
  );

  await triggerMatcher.react(
    commentCreatedEvent({
      seed,
      parentId: wi.id,
      agentSlug: 'helper',
      kind: 'rejection',
      actor: seed.user.id,
    }),
  );

  const run = await db.query.documents.findFirst({ where: eq(documents.id, runId) });
  expect(run?.status).toBe('rejected');
});

test('resume_run creates a NEW planning row with frontmatter.resume_of + inherited chain_id', async () => {
  const { db, seed } = await makeTestApp();
  await seedTriggers(db, seed.workspace.id, seed.user.id);
  const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
  const wiTable = await getWorkItemsTable(db, seed.project.id);
  const wi = await seedWorkItem(db, seed.workspace, seed.project, wiTable, seed.user);
  const runsTable = await ensureRunsTableFor(db, seed);
  const chainId = crypto.randomUUID();
  const originalId = await seedAwaitingApprovalRun(
    db,
    seed.workspace,
    seed.project,
    runsTable,
    agent,
    wi,
    seed.user,
    chainId,
  );

  await triggerMatcher.react(
    commentCreatedEvent({
      seed,
      parentId: wi.id,
      agentSlug: 'helper',
      kind: 'approval',
      actor: seed.user.id,
    }),
  );

  // Two runs now: the original awaiting_approval + the new planning resume row.
  expect(await countRuns(db, wi.id, 'helper')).toBe(2);

  const resumeRow = await db.query.documents.findFirst({
    where: and(
      eq(documents.type, 'agent_run'),
      eq(documents.parentId, wi.id),
      eq(documents.status, 'planning'),
    ),
  });
  expect(resumeRow).toBeTruthy();
  const fm = resumeRow?.frontmatter as Record<string, unknown>;
  // The poller routes on `frontmatter.resume_of` being a string.
  expect(typeof fm.resume_of).toBe('string');
  expect(fm.resume_of).toBe(originalId);
  // chain_id is INHERITED — a resume continues the original chain.
  expect(fm.chain_id).toBe(chainId);
  // Owned by the originating human.
  expect(resumeRow?.createdBy).toBe(seed.user.id);
});

test('resume_run of a body-less agent FAILS the stranded run (not skip-and-dangle, not halt)', async () => {
  // Regression: the reactor skip is correct for FRESH triggers (no run to
  // strand) but on RESUME the original awaiting_approval run's only exit is the
  // resume row. A bare skip would leave it dangling forever (no sweeper touches
  // awaiting_approval) with no operator feedback. So an empty-prompt agent must
  // FAIL the original run (transitionRun → failed + agent.run.failed event),
  // never silently skip and never throw (which would halt the reactor).
  const { db, seed } = await makeTestApp();
  await seedTriggers(db, seed.workspace.id, seed.user.id);
  // Agent whose body (prompt) was cleared after the run entered awaiting_approval.
  const agent = await seedAgent(db, seed.workspace, seed.user, 'helper', undefined, '   ');
  const wiTable = await getWorkItemsTable(db, seed.project.id);
  const wi = await seedWorkItem(db, seed.workspace, seed.project, wiTable, seed.user);
  const runsTable = await ensureRunsTableFor(db, seed);
  const originalId = await seedAwaitingApprovalRun(
    db,
    seed.workspace,
    seed.project,
    runsTable,
    agent,
    wi,
    seed.user,
  );

  // Must NOT throw (a throw = halted reactor).
  await triggerMatcher.react(
    commentCreatedEvent({
      seed,
      parentId: wi.id,
      agentSlug: 'helper',
      kind: 'approval',
      actor: seed.user.id,
    }),
  );

  // No resume row created.
  expect(await countRuns(db, wi.id, 'helper')).toBe(1);
  // The original run was FAILED (not left dangling in awaiting_approval).
  const run = await db.query.documents.findFirst({ where: eq(documents.id, originalId) });
  expect(run?.status).toBe('failed');
  expect((run?.frontmatter as { error_reason?: string }).error_reason).toBe('prompt_empty');
});

test('resume_run fired TWICE creates exactly ONE resume row (idempotency, mitigation 52)', async () => {
  const { db, seed } = await makeTestApp();
  await seedTriggers(db, seed.workspace.id, seed.user.id);
  const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
  const wiTable = await getWorkItemsTable(db, seed.project.id);
  const wi = await seedWorkItem(db, seed.workspace, seed.project, wiTable, seed.user);
  const runsTable = await ensureRunsTableFor(db, seed);
  await seedAwaitingApprovalRun(db, seed.workspace, seed.project, runsTable, agent, wi, seed.user);

  const ev = () =>
    commentCreatedEvent({
      seed,
      parentId: wi.id,
      agentSlug: 'helper',
      kind: 'approval',
      actor: seed.user.id,
    });

  await triggerMatcher.react(ev());
  await triggerMatcher.react(ev()); // at-least-once replay

  // original awaiting_approval (1) + exactly one planning resume row (1) = 2.
  expect(await countRuns(db, wi.id, 'helper')).toBe(2);
  const planningRows = await db.query.documents.findMany({
    where: and(
      eq(documents.type, 'agent_run'),
      eq(documents.parentId, wi.id),
      eq(documents.status, 'planning'),
    ),
  });
  expect(planningRows.length).toBe(1);
});

test('reject_run is a no-op (no throw) when the run already left awaiting_approval (race, mitigation 43)', async () => {
  const { db, seed } = await makeTestApp();
  await seedTriggers(db, seed.workspace.id, seed.user.id);
  const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
  const wiTable = await getWorkItemsTable(db, seed.project.id);
  const wi = await seedWorkItem(db, seed.workspace, seed.project, wiTable, seed.user);
  const runsTable = await ensureRunsTableFor(db, seed);
  const runId = await seedAwaitingApprovalRun(
    db,
    seed.workspace,
    seed.project,
    runsTable,
    agent,
    wi,
    seed.user,
  );
  // Simulate the approval handler having already moved the run out of
  // awaiting_approval (e.g. resumed → running). getPendingApprovalRun then
  // returns null and the handler skips before ever calling rejectRun; even if
  // it did, rejectRun catches the race. Either way: no throw.
  await db
    .update(documents)
    .set({
      status: 'running',
      frontmatter: sql`json_set(${documents.frontmatter}, '$.status', 'running')`,
    })
    .where(eq(documents.id, runId));

  // Must not throw.
  await triggerMatcher.react(
    commentCreatedEvent({
      seed,
      parentId: wi.id,
      agentSlug: 'helper',
      kind: 'rejection',
      actor: seed.user.id,
    }),
  );

  const run = await db.query.documents.findFirst({ where: eq(documents.id, runId) });
  expect(run?.status).toBe('running'); // untouched
});

// ----- Finding 1: prefixed `agent:<slug>` target_agent must still resolve -----
//
// The cancel route (routes/runs.ts) emits `target_agent: 'agent:<slug>'`, and
// clients can supply the prefixed form per the comment-schema "three forms".
// The handler passed `target_agent` RAW to getPendingApprovalRun, which matches
// the BARE slug — so a prefixed value found NO run and the approval/rejection
// silently no-op'd. These two tests use the PREFIXED form; they fail before the
// normalize fix.

test('reject_run resolves a PREFIXED target_agent (agent:<slug>) and rejects the run (Finding 1)', async () => {
  const { db, seed } = await makeTestApp();
  await seedTriggers(db, seed.workspace.id, seed.user.id);
  const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
  const wiTable = await getWorkItemsTable(db, seed.project.id);
  const wi = await seedWorkItem(db, seed.workspace, seed.project, wiTable, seed.user);
  const runsTable = await ensureRunsTableFor(db, seed);
  const runId = await seedAwaitingApprovalRun(
    db,
    seed.workspace,
    seed.project,
    runsTable,
    agent,
    wi,
    seed.user,
  );

  await triggerMatcher.react(
    commentCreatedEvent({
      seed,
      parentId: wi.id,
      agentSlug: 'helper',
      targetAgent: 'agent:helper', // PREFIXED form (cancel route + client "three forms")
      kind: 'rejection',
      actor: seed.user.id,
    }),
  );

  const run = await db.query.documents.findFirst({ where: eq(documents.id, runId) });
  expect(run?.status).toBe('rejected');
});

test('resume_run resolves a PREFIXED target_agent (agent:<slug>) and creates the resume row (Finding 1)', async () => {
  const { db, seed } = await makeTestApp();
  await seedTriggers(db, seed.workspace.id, seed.user.id);
  const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
  const wiTable = await getWorkItemsTable(db, seed.project.id);
  const wi = await seedWorkItem(db, seed.workspace, seed.project, wiTable, seed.user);
  const runsTable = await ensureRunsTableFor(db, seed);
  const originalId = await seedAwaitingApprovalRun(
    db,
    seed.workspace,
    seed.project,
    runsTable,
    agent,
    wi,
    seed.user,
  );

  await triggerMatcher.react(
    commentCreatedEvent({
      seed,
      parentId: wi.id,
      agentSlug: 'helper',
      targetAgent: 'agent:helper', // PREFIXED form
      kind: 'approval',
      actor: seed.user.id,
    }),
  );

  // original awaiting_approval + the new planning resume row.
  expect(await countRuns(db, wi.id, 'helper')).toBe(2);
  const resumeRow = await db.query.documents.findFirst({
    where: and(
      eq(documents.type, 'agent_run'),
      eq(documents.parentId, wi.id),
      eq(documents.status, 'planning'),
    ),
  });
  expect(resumeRow).toBeTruthy();
  expect((resumeRow?.frontmatter as Record<string, unknown>).resume_of).toBe(originalId);
});
