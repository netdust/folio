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
  memberships as schemaMemberships,
  projects as schemaProjects,
  tables,
  workspaces as schemaWorkspaces,
} from '../db/schema.ts';
import { env } from '../env.ts';
import { makeTestApp } from '../test/harness.ts';
import type { TestSeed } from '../test/harness.ts';
import { callerProjectsFor } from './agent-projects.ts';
import { roleToScopes, toolsToScopes } from './agent-schema.ts';
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
   * comments.ts "three forms" — Finding 1). Pass `null` to OMIT `target_agent`
   * entirely (isolating the `target_agent_id` id-handle path — C1).
   */
  targetAgent?: string | null;
  /**
   * The immutable `target_agent_id` doc-id handle (BUG-013). When present, the
   * matcher resolves the agent doc by id to its slug (instance-wide, no tenancy
   * boundary). Omitted by default.
   */
  targetAgentId?: string;
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
      // `null` → omit the literal target_agent (isolate the id-handle path).
      ...(args.targetAgent === null
        ? {}
        : { target_agent: args.targetAgent ?? args.agentSlug }),
      ...(args.targetAgentId ? { target_agent_id: args.targetAgentId } : {}),
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

// ----- Phase 4: instance-wide slug resolution (no tenancy boundary) -----
//
// Tenancy is dropped: an agent resolves by slug INSTANCE-WIDE (resolveAgentForRun
// has no workspace predicate). There is no `__system` library, no shadowing, and
// no third-workspace fail-closed wall. Confidentiality between projects is the
// project ceiling (frontmatter.projects) + caller-bound, not a workspace wall.

/** Seed a second workspace D — proves cross-workspace by-slug resolution. */
async function seedOtherWorkspace(db: TestDB): Promise<Workspace> {
  const id = nanoid();
  await db.insert(schemaWorkspaces).values({ id, slug: `d-${nanoid(6)}`, name: 'Workspace D' });
  const row = await db.query.workspaces.findFirst({ where: eq(schemaWorkspaces.id, id) });
  if (!row) throw new Error('test setup: workspace D insert did not round-trip');
  return row;
}

test('a B trigger resolves an agent that lives in ANOTHER workspace by slug (instance-wide, no tenancy wall)', async () => {
  const { db, seed } = await makeTestApp();
  // B has its builtin-on-assignment trigger but NO local 'ops'.
  await seedTriggers(db, seed.workspace.id, seed.user.id);
  // 'ops' lives in a DIFFERENT workspace D. With tenancy dropped, the slug still
  // resolves instance-wide → the B trigger fires it. Its allow-list is wildcard
  // so the project ceiling permits this project.
  const otherWs = await seedOtherWorkspace(db);
  const remoteAgent = await seedAgent(db, otherWs, seed.user, 'ops');
  const wiTable = await getWorkItemsTable(db, seed.project.id);
  const wi = await seedWorkItem(db, seed.workspace, seed.project, wiTable, seed.user);

  await triggerMatcher.react(
    assignmentEvent({
      seed,
      workItem: wi,
      agentSlug: 'ops',
      agentId: remoteAgent.id,
      actor: seed.user.id,
    }),
  );

  expect(await countRuns(db, wi.id, 'ops')).toBe(1);
  const run = await db.query.documents.findFirst({
    where: and(eq(documents.type, 'agent_run'), eq(documents.parentId, wi.id)),
  });
  expect(run?.status).toBe('planning');
});

test('resolveTargetAgentSlug resolves a target_agent_id pointing at an agent in another workspace (instance-wide id-handle)', async () => {
  // The id-handle branch in resolveTargetAgentSlug (internal_action approval
  // path) resolves a target_agent_id to its slug instance-wide — no home
  // assertion remains. The approval reaches B's pending run via the resolved
  // slug regardless of which workspace the agent doc physically lives in.
  const { db, seed } = await makeTestApp();
  await seedTriggers(db, seed.workspace.id, seed.user.id);
  const otherWs = await seedOtherWorkspace(db);
  // The id-handle points at an agent in another workspace that shares slug
  // 'helper'. It resolves to slug 'helper' → finds B's pending 'helper' run
  // (parent-scoped) → the approval (rejection) acts on it.
  const remoteAgent = await seedAgent(db, otherWs, seed.user, 'helper');
  const wiTable = await getWorkItemsTable(db, seed.project.id);
  const wi = await seedWorkItem(db, seed.workspace, seed.project, wiTable, seed.user);
  const runsTable = await ensureRunsTableFor(db, seed);
  const originalId = await seedAwaitingApprovalRun(
    db,
    seed.workspace,
    seed.project,
    runsTable,
    remoteAgent,
    wi,
    seed.user,
  );

  await triggerMatcher.react(
    commentCreatedEvent({
      seed,
      parentId: wi.id,
      agentSlug: 'helper',
      targetAgent: null, // omit the literal slug → isolate the id-handle path
      targetAgentId: remoteAgent.id,
      kind: 'rejection',
      actor: seed.user.id,
    }),
  );

  // The id-handle resolved to slug 'helper' → the parent-scoped pending run was
  // rejected. The boundary is the pending RUN's parent (in B), not a workspace
  // wall on the agent doc.
  const run = await db.query.documents.findFirst({ where: eq(documents.id, originalId) });
  expect(run?.status).toBe('rejected');
});

// ----- review-fix #3: approval/rejection falls back to the run's FROZEN
// agent_slug when the agent doc has been DELETED -----
//
// resolveTargetAgentSlug's STRING fallback routes through resolveAgentForRun,
// which requires the agent doc to still EXIST. But the approval/rejection path's
// real key is the run's FROZEN
// `frontmatter.agent_slug` (what getPendingApprovalRun matches), NOT the live
// agent doc. If the agent doc is deleted after its run reaches
// awaiting_approval, a human's reject/resume comment (carrying
// `target_agent: '<slug>'`, no id) could no longer resolve → the run was
// STRANDED forever (no sweeper touches awaiting_approval). The fix: when
// resolveAgentForRun finds nothing, fall back to the normalized bare slug
// verbatim so the EXISTING in-workspace pending run stays actionable.

test('reject_run resolves via the run\'s FROZEN agent_slug even after the agent doc is DELETED (review-fix #3)', async () => {
  // RED before the fix: resolveAgentForRun returns undefined for the deleted
  // agent → resolveTargetAgentSlug returns undefined → handleInternalAction
  // skips → the awaiting_approval run is stranded (never rejected).
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

  // The agent doc is DELETED after the run reached awaiting_approval.
  await db.delete(documents).where(eq(documents.id, agent.id));

  await triggerMatcher.react(
    commentCreatedEvent({
      seed,
      parentId: wi.id,
      agentSlug: 'helper',
      kind: 'rejection',
      actor: seed.user.id,
      // bare slug only, no id-handle — the realistic stranded-run shape.
    }),
  );

  // The frozen agent_slug ('helper') still selects the pending run → rejected.
  const run = await db.query.documents.findFirst({ where: eq(documents.id, runId) });
  expect(run?.status).toBe('rejected');
});

test('reject_run still resolves the live agent in the normal case (no regression)', async () => {
  // The verbatim fallback must NOT change the normal path: an existing agent
  // resolves via resolveAgentForRun → its slug → the pending run rejects.
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

test('the verbatim fallback is parent-scoped — a slug with no pending run under this parent is a benign no-op (review-fix #3 security)', async () => {
  // The verbatim fallback returns a bare slug, which flows into
  // getPendingApprovalRun({ parentId, agentSlug }) — scoped by parentId. With no
  // awaiting_approval run for that slug under THIS parent, nothing matches and no
  // run is rejected. Proves the authority boundary is the pending RUN (selected
  // by parent), not the bare slug.
  const { db, seed } = await makeTestApp();
  await seedTriggers(db, seed.workspace.id, seed.user.id);
  // 'phantom' agent exists but has NO pending run under this parent.
  await seedAgent(db, seed.workspace, seed.user, 'phantom');
  const wiTable = await getWorkItemsTable(db, seed.project.id);
  const wi = await seedWorkItem(db, seed.workspace, seed.project, wiTable, seed.user);
  await ensureRunsTableFor(db, seed);

  await triggerMatcher.react(
    commentCreatedEvent({
      seed,
      parentId: wi.id,
      agentSlug: 'phantom',
      kind: 'rejection',
      actor: seed.user.id,
    }),
  );

  // No pending run under this parent for 'phantom' → nothing matched, nothing
  // rejected. Benign no-op — the slug alone can't reject a run.
  expect(await countRuns(db, wi.id, 'phantom')).toBe(0);
});

// ----- Phase 4: the allow-list fire-gate ALWAYS applies (invariant 3) -----
//
// With library agents gone, there is no `__system`-home skip. EVERY agent is
// bounded to its `frontmatter.projects` at the fire decision, and its AUTHORITY
// in the run is bounded at run time by loadContext's caller-bounded narrowing.

test('an agent respects its allow-list fire-gate — excluded project means no run (mitigation 50)', async () => {
  const { db, seed } = await makeTestApp();
  await seedTriggers(db, seed.workspace.id, seed.user.id);
  // An agent whose allow-list names a DIFFERENT project (not this event's
  // project) → the allow-list gate applies → no run.
  const agent = await seedAgent(db, seed.workspace, seed.user, 'helper', ['a-different-project-id']);
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

  // Allow-list excludes this project → gate applies → zero runs.
  expect(await countRuns(db, wi.id, 'helper')).toBe(0);
});

test('a fired run is caller-bounded — authority is the event-human, not the agent claim (invariant 3)', async () => {
  const { db, seed } = await makeTestApp();
  await seedTriggers(db, seed.workspace.id, seed.user.id);
  // An agent with a wildcard authority claim — its `projects` is ['*'] so its
  // OWN reach is "all". If authority leaked from the agent, the run would carry
  // the agent's wildcard. It must instead carry the EVENT-HUMAN's B membership
  // snapshot (the actor is seed.user, an OWNER of B).
  const agent = await seedAgent(db, seed.workspace, seed.user, 'ops', ['*']);
  const wiTable = await getWorkItemsTable(db, seed.project.id);
  const wi = await seedWorkItem(db, seed.workspace, seed.project, wiTable, seed.user);

  await triggerMatcher.react(
    assignmentEvent({
      seed,
      workItem: wi,
      agentSlug: 'ops',
      agentId: agent.id,
      actor: seed.user.id,
    }),
  );

  expect(await countRuns(db, wi.id, 'ops')).toBe(1);
  const run = await db.query.documents.findFirst({
    where: and(eq(documents.type, 'agent_run'), eq(documents.parentId, wi.id)),
  });
  const fm = run?.frontmatter as Record<string, unknown>;

  // Derive what the EVENT-HUMAN (seed.user) would get from their B membership:
  // the harness seeds seed.user as an OWNER of B → all document scopes, and
  // callerProjectsFor(owner) === null (no project narrowing). Authority is the
  // CALLER's, NOT the agent's ['*'] claim.
  const membership = await db.query.memberships.findFirst({
    where: and(
      eq(schemaMemberships.workspaceId, seed.workspace.id),
      eq(schemaMemberships.userId, seed.user.id),
    ),
  });
  const role = membership?.role as 'owner' | 'admin' | 'member';
  const memberProjectIds =
    role === 'member'
      ? (
          await db.query.projects.findMany({
            where: eq(schemaProjects.workspaceId, seed.workspace.id),
            columns: { id: true },
          })
        ).map((p) => p.id)
      : [];

  expect(fm.caller_scopes).toEqual(roleToScopes(role));
  expect(fm.caller_project_ids).toEqual(callerProjectsFor({ role, projectIds: memberProjectIds }));
});

// ----- Phase 4: autonomy-gate suppression + caller resolution + owner guard --
//
// These boundaries survive tenancy drop (plain agents):
// C4 (autonomy gate): an agent-ORIGINATED event is RESOLVED first (allow-list),
//     THEN suppressed by the autonomy gate with chains off.
// C5 (caller resolution): a HUMAN-caused trigger fires a run OWNED by that human
//     (createdBy === the event-human's user id), never a system actor.
// step-6 owner guard: a caller-less trigger (event.actor resolves to no human)
//     does NOT fire — a run with no resolvable human owner is skipped.

test('an agent-originated event firing another agent is suppressed with chains off (C4)', async () => {
  const { db, seed } = await makeTestApp();
  (env as Record<string, unknown>)[flagKey] = false; // default; explicit for clarity
  await seedTriggers(db, seed.workspace.id, seed.user.id);
  const agent = await seedAgent(db, seed.workspace, seed.user, 'ops');
  const wiTable = await getWorkItemsTable(db, seed.project.id);
  const wi = await seedWorkItem(db, seed.workspace, seed.project, wiTable, seed.user);

  const suppressed: string[] = [];
  const unsub = eventBus.subscribe(seed.workspace.id, undefined, (e) => {
    if (e.kind === 'agent.chain.suppressed') suppressed.push(e.kind);
  });
  // actor = 'agent:<another agent>' → agent-originated. The event targets 'ops';
  // resolution + allow-list both succeed, then the autonomy gate suppresses the
  // chain hop.
  await triggerMatcher.react(
    assignmentEvent({
      seed,
      workItem: wi,
      agentSlug: 'ops',
      agentId: agent.id,
      actor: 'agent:librarian',
    }),
  );
  unsub();

  // Zero runs created; exactly one suppression signal (the gate ran AFTER
  // resolution and suppressed — it did not silently drop pre-resolution).
  expect(await countRuns(db, wi.id, 'ops')).toBe(0);
  expect(suppressed.length).toBe(1);
});

test('a trigger-fired run uses the event-human as caller, not a system actor (C5)', async () => {
  const { db, seed } = await makeTestApp();
  await seedTriggers(db, seed.workspace.id, seed.user.id);
  // The firing event is caused by a real human (an OWNER of B). The fired run
  // must be OWNED by that human — not a 'system:' actor (which would violate the
  // documents.created_by → users.id FK) and not the agent.
  const agent = await seedAgent(db, seed.workspace, seed.user, 'ops');
  const wiTable = await getWorkItemsTable(db, seed.project.id);
  const wi = await seedWorkItem(db, seed.workspace, seed.project, wiTable, seed.user);

  await triggerMatcher.react(
    assignmentEvent({
      seed,
      workItem: wi,
      agentSlug: 'ops',
      agentId: agent.id,
      actor: seed.user.id, // a real users.id (session path)
    }),
  );

  expect(await countRuns(db, wi.id, 'ops')).toBe(1);
  const run = await db.query.documents.findFirst({
    where: and(eq(documents.type, 'agent_run'), eq(documents.parentId, wi.id)),
  });
  // The caller is the event-human (resolveOwnerUser(event.actor)), NOT a
  // system actor and NOT the agent.
  expect(run?.createdBy).toBe(seed.user.id);
});

test('a caller-less (actor-less / unresolvable) trigger does NOT fire — no resolvable human owner (step-6 guard)', async () => {
  const { db, seed } = await makeTestApp();
  (env as Record<string, unknown>)[flagKey] = false;
  await seedTriggers(db, seed.workspace.id, seed.user.id);
  // An agent. The actor is a NON-agent, UNRESOLVABLE id — it does NOT start with
  // 'agent:' (so isAgentOriginated is false → the autonomy gate does NOT fire
  // and emits NO agent.chain.suppressed) and it resolves to no users.id and no
  // human PAT (so resolveOwnerUser → null). The step-6 owner guard skips a run
  // it cannot attribute to a human. (Scheduled/cron — Phase 3.5 — is the
  // canonical caller-less case; this stand-in models any unresolvable actor.)
  const agent = await seedAgent(db, seed.workspace, seed.user, 'helper');
  const wiTable = await getWorkItemsTable(db, seed.project.id);
  const wi = await seedWorkItem(db, seed.workspace, seed.project, wiTable, seed.user);

  const suppressed: string[] = [];
  const unsub = eventBus.subscribe(seed.workspace.id, undefined, (e) => {
    if (e.kind === 'agent.chain.suppressed') suppressed.push(e.kind);
  });
  await triggerMatcher.react(
    assignmentEvent({
      seed,
      workItem: wi,
      agentSlug: 'helper',
      agentId: agent.id,
      actor: `ghost-${nanoid(8)}`, // non-agent, unresolvable
    }),
  );
  unsub();

  // step-6 owner guard skips a caller-less run → no run, no suppression.
  expect(await countRuns(db, wi.id, 'helper')).toBe(0);
  expect(suppressed.length).toBe(0);
});
