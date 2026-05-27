/**
 * Service-level tests for the comments service.
 *
 * These call the service functions directly, bypassing HTTP. The route tests
 * in routes/comments.test.ts (Task A6) will cover the HTTP layer.
 *
 * Test seed: harness gives us a user (Alice) + a workspace + a project + a
 * default work-items table. We seed extra rows (parent docs, agents, members)
 * per test.
 */

import { test, expect } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { makeTestApp } from '../test/harness.ts';
import {
  apiTokens,
  documents,
  events,
  memberships,
  tables,
  users,
  type Document,
  type User,
  type Workspace,
  type Project,
  type TableEntity,
} from '../db/schema.ts';
import { newApiToken } from '../lib/auth.ts';
import { toolsToScopes } from '../lib/agent-schema.ts';
import {
  createComment,
  updateComment,
  deleteComment,
  getComment,
  listComments,
  type AuthorContext,
} from './comments.ts';
import { HTTPError } from '../lib/http.ts';

type TestDB = Awaited<ReturnType<typeof makeTestApp>>['db'];

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
  overrides: Partial<{ slug: string; title: string }> = {},
): Promise<Document> {
  const id = nanoid();
  const slug = overrides.slug ?? `wi-${nanoid(6)}`;
  await db.insert(documents).values({
    id,
    workspaceId: workspace.id,
    projectId: project.id,
    tableId: table.id,
    type: 'work_item',
    slug,
    title: overrides.title ?? 'Parent WI',
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
  allowedProjects: string[] = ['*'],
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
      system_prompt: 'help',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      tools: ['list_documents'],
      projects: allowedProjects,
      max_delegation_depth: 2,
      max_tokens_per_run: 10_000,
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

async function seedMember(
  db: TestDB,
  workspace: Workspace,
  email: string,
  name: string,
): Promise<User> {
  const id = nanoid();
  await db.insert(users).values({ id, email, name, passwordHash: null });
  await db.insert(memberships).values({
    workspaceId: workspace.id,
    userId: id,
    role: 'member',
  });
  const row = await db.query.users.findFirst({ where: eq(users.id, id) });
  return row!;
}

function userContext(user: User): AuthorContext {
  return { type: 'user', userId: user.id };
}

// -----------------------------------------------------------------------------
// createComment — happy path & shape
// -----------------------------------------------------------------------------

test('createComment happy path: returns a Document with type=comment + c- slug + author frontmatter', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);

  const comment = await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: 'Hello world',
  });

  expect(comment.type).toBe('comment');
  expect(comment.slug.startsWith('c-')).toBe(true);
  expect(comment.parentId).toBe(parent.id);
  expect(comment.tableId).toBeNull();
  expect(comment.body).toBe('Hello world');
  const fm = comment.frontmatter as Record<string, unknown>;
  expect(fm.author).toBe(`user:${seed.user.id}`);
  expect(fm.kind).toBe('comment');
  expect(fm.visibility).toBe('normal');
  expect(Array.isArray(fm.mentions)).toBe(true);
});

test('createComment persists the row to the documents table', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);

  const comment = await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: 'persist me',
  });

  const row = await db.query.documents.findFirst({ where: eq(documents.id, comment.id) });
  expect(row).toBeTruthy();
  expect(row!.body).toBe('persist me');
});

// -----------------------------------------------------------------------------
// createComment — validation
// -----------------------------------------------------------------------------

test('createComment rejects parent of type agent with INVALID_COMMENT_PARENT', async () => {
  const { db, seed } = await makeTestApp();
  const agent = await seedAgent(db, seed.workspace, seed.user, 'drafter');

  let thrown: unknown = null;
  try {
    await createComment({
      workspace: seed.workspace,
      project: seed.project,
      parent: agent,
      authorContext: userContext(seed.user),
      actor: seed.user.id,
      body: 'nope',
    });
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(HTTPError);
  expect((thrown as HTTPError).code).toBe('INVALID_COMMENT_PARENT');
  expect((thrown as HTTPError).status).toBe(422);
});

test('createComment rejects empty body with EMPTY_COMMENT_BODY', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);

  let thrown: unknown = null;
  try {
    await createComment({
      workspace: seed.workspace,
      project: seed.project,
      parent,
      authorContext: userContext(seed.user),
      actor: seed.user.id,
      body: '   \n\t  ',
    });
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(HTTPError);
  expect((thrown as HTTPError).code).toBe('EMPTY_COMMENT_BODY');
});

test('createComment rejects body > 64KB with COMMENT_BODY_TOO_LARGE', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);

  const tooBig = 'a'.repeat(64 * 1024 + 1);

  let thrown: unknown = null;
  try {
    await createComment({
      workspace: seed.workspace,
      project: seed.project,
      parent,
      authorContext: userContext(seed.user),
      actor: seed.user.id,
      body: tooBig,
    });
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(HTTPError);
  expect((thrown as HTTPError).code).toBe('COMMENT_BODY_TOO_LARGE');
});

test('createComment rejects target_agent on plain comment kind with TARGET_AGENT_FORBIDDEN', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);

  let thrown: unknown = null;
  try {
    await createComment({
      workspace: seed.workspace,
      project: seed.project,
      parent,
      authorContext: userContext(seed.user),
      actor: seed.user.id,
      body: 'plain text',
      kind: 'comment',
      targetAgent: 'drafter',
    });
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(HTTPError);
  expect((thrown as HTTPError).code).toBe('TARGET_AGENT_FORBIDDEN');
});

test('createComment with kind=approval but no target_agent and no keyword throws TARGET_AGENT_REQUIRED', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);

  let thrown: unknown = null;
  try {
    await createComment({
      workspace: seed.workspace,
      project: seed.project,
      parent,
      authorContext: userContext(seed.user),
      actor: seed.user.id,
      body: 'looks good',
      kind: 'approval',
    });
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(HTTPError);
  expect((thrown as HTTPError).code).toBe('TARGET_AGENT_REQUIRED');
});

test('createComment rejects parent in a different workspace with INVALID_COMMENT_PARENT', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);

  // Forge a workspace mismatch by passing a parent whose workspaceId !== input workspace.
  const otherWorkspace: Workspace = { ...seed.workspace, id: 'ws-not-real' };

  let thrown: unknown = null;
  try {
    await createComment({
      workspace: otherWorkspace,
      project: seed.project,
      parent,
      authorContext: userContext(seed.user),
      actor: seed.user.id,
      body: 'mismatch',
    });
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(HTTPError);
  expect((thrown as HTTPError).code).toBe('INVALID_COMMENT_PARENT');
});

// -----------------------------------------------------------------------------
// createComment — approval keyword override
// -----------------------------------------------------------------------------

test('createComment approval keyword overrides client kind=comment to approval and sets target_agent', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  await seedAgent(db, seed.workspace, seed.user, 'drafter');

  const comment = await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: '@drafter approved — looks great',
    // Client says kind=comment; server should override to approval.
    kind: 'comment',
  });

  const fm = comment.frontmatter as Record<string, unknown>;
  expect(fm.kind).toBe('approval');
  expect(fm.target_agent).toBe('drafter');
});

// BUG-013 — persist target_agent_id alongside target_agent so Phase 3
// dispatcher + ApprovalButtons survive renames. Keyword path: parseMentions
// already resolved the agent's id; service writes both fields.
test('BUG-013: keyword-path approval persists both target_agent (slug) and target_agent_id (id)', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const agent = await seedAgent(db, seed.workspace, seed.user, 'drafter');

  const comment = await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: '@drafter approved',
  });

  const fm = comment.frontmatter as Record<string, unknown>;
  expect(fm.kind).toBe('approval');
  expect(fm.target_agent).toBe('drafter');
  expect(fm.target_agent_id).toBe(agent.id);
});

// BUG-013 — client-path approval: client passes target_agent as slug or
// `agent:<slug>`; service looks up the agent and writes target_agent_id.
test('BUG-013: client-path approval looks up agent id from slug and persists both fields', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const agent = await seedAgent(db, seed.workspace, seed.user, 'drafter');

  const comment = await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: 'lgtm',
    kind: 'approval',
    targetAgent: 'agent:drafter',
  });

  const fm = comment.frontmatter as Record<string, unknown>;
  expect(fm.target_agent).toBe('agent:drafter');
  expect(fm.target_agent_id).toBe(agent.id);
});

// BUG-013 — comment.created event payload carries target_agent_id too so
// Phase 3 subscribers can resolve by id off the event without re-reading
// the row.
test('BUG-013: comment.created event payload includes target_agent_id when present', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const agent = await seedAgent(db, seed.workspace, seed.user, 'drafter');

  const comment = await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: '@drafter approved',
  });

  const createdEvents = await db.query.events.findMany({
    where: and(eq(events.documentId, comment.id), eq(events.kind, 'comment.created')),
  });
  expect(createdEvents.length).toBe(1);
  const payload = createdEvents[0]!.payload as Record<string, unknown>;
  expect(payload.target_agent).toBe('drafter');
  expect(payload.target_agent_id).toBe(agent.id);
});

// -----------------------------------------------------------------------------
// createComment — event emission
// -----------------------------------------------------------------------------

test('createComment emits comment.created event once', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);

  const comment = await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: 'hello',
  });

  const rows = await db.query.events.findMany({
    where: and(eq(events.documentId, comment.id), eq(events.kind, 'comment.created')),
  });
  expect(rows.length).toBe(1);
  const payload = rows[0]!.payload as Record<string, unknown>;
  expect(payload.document_id).toBe(comment.id);
  expect(payload.parent_id).toBe(parent.id);
  expect(payload.author).toBe(`user:${seed.user.id}`);
  expect(payload.kind).toBe('comment');
});

test('createComment emits one comment.mentioned per resolved-agent mention', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  await seedAgent(db, seed.workspace, seed.user, 'drafter');
  await seedAgent(db, seed.workspace, seed.user, 'reviewer');

  const comment = await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: 'cc @drafter and @reviewer please',
  });

  const rows = await db.query.events.findMany({
    where: and(eq(events.documentId, comment.id), eq(events.kind, 'comment.mentioned')),
  });
  expect(rows.length).toBe(2);
  const slugs = rows.map((r) => (r.payload as Record<string, unknown>).agent_slug).sort();
  expect(slugs).toEqual(['drafter', 'reviewer']);
});

test('createComment does not emit comment.mentioned for unresolved mentions', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);

  const comment = await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: 'cc @ghost',
  });

  const rows = await db.query.events.findMany({
    where: and(eq(events.documentId, comment.id), eq(events.kind, 'comment.mentioned')),
  });
  expect(rows.length).toBe(0);
});

// -----------------------------------------------------------------------------
// updateComment — author-only + kind immutability + edited_at + mention diff
// -----------------------------------------------------------------------------

test('updateComment rejects non-author with COMMENT_AUTHOR_ONLY (403)', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const comment = await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: 'mine',
  });

  const bob = await seedMember(db, seed.workspace, 'bob@test.local', 'Bob');

  let thrown: unknown = null;
  try {
    await updateComment({
      workspace: seed.workspace,
      project: seed.project,
      existing: comment,
      authorContext: userContext(bob),
      actor: bob.id,
      body: 'hijacked',
    });
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(HTTPError);
  expect((thrown as HTTPError).code).toBe('COMMENT_AUTHOR_ONLY');
  expect((thrown as HTTPError).status).toBe(403);
});

test('updateComment with kind in patch throws KIND_IMMUTABLE', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const comment = await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: 'plain',
  });

  let thrown: unknown = null;
  try {
    await updateComment({
      workspace: seed.workspace,
      project: seed.project,
      existing: comment,
      authorContext: userContext(seed.user),
      actor: seed.user.id,
      kind: 'plan',
    });
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(HTTPError);
  expect((thrown as HTTPError).code).toBe('KIND_IMMUTABLE');
});

test('updateComment sets edited_at on body change', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const comment = await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: 'first',
  });

  const updated = await updateComment({
    workspace: seed.workspace,
    project: seed.project,
    existing: comment,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: 'second',
  });

  expect(updated.body).toBe('second');
  const fm = updated.frontmatter as Record<string, unknown>;
  expect(typeof fm.edited_at).toBe('string');
});

test('updateComment fires comment.mentioned only for newly resolved agents', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  await seedAgent(db, seed.workspace, seed.user, 'drafter');
  await seedAgent(db, seed.workspace, seed.user, 'reviewer');

  // Create mentions only drafter.
  const comment = await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: 'hey @drafter',
  });

  // Confirm initial state: 1 mentioned event.
  const before = await db.query.events.findMany({
    where: and(eq(events.documentId, comment.id), eq(events.kind, 'comment.mentioned')),
  });
  expect(before.length).toBe(1);

  // Update to also mention reviewer; drafter mention persists.
  await updateComment({
    workspace: seed.workspace,
    project: seed.project,
    existing: comment,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: 'hey @drafter and @reviewer',
  });

  const after = await db.query.events.findMany({
    where: and(eq(events.documentId, comment.id), eq(events.kind, 'comment.mentioned')),
  });
  // 1 original + 1 new (reviewer only — drafter was already mentioned).
  expect(after.length).toBe(2);
  // The NEW event should be for reviewer.
  const sortedByTime = [...after].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  const newest = sortedByTime[sortedByTime.length - 1]!;
  expect((newest.payload as Record<string, unknown>).agent_slug).toBe('reviewer');
});

test('updateComment does not emit a comment.updated event', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const comment = await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: 'first',
  });
  await updateComment({
    workspace: seed.workspace,
    project: seed.project,
    existing: comment,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: 'second',
  });

  const updateEvents = await db.query.events.findMany({
    where: and(eq(events.documentId, comment.id), eq(events.kind, 'comment.updated' as never)),
  });
  expect(updateEvents.length).toBe(0);
});

// Spec §3c deferral pin: editing the body of an approval comment does NOT
// recompute target_agent. target_agent is bound to creation-time intent and
// kind is immutable; this guarantees the pair stays consistent across edits.
// Removing this test means lifting the deferral and implementing the recompute.
test('updateComment on kind=approval does NOT recompute target_agent on body change', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  await seedAgent(db, seed.workspace, seed.user, 'drafter');
  await seedAgent(db, seed.workspace, seed.user, 'reviewer');

  const comment = await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: '@drafter approved — ship it',
  });
  const beforeFm = comment.frontmatter as Record<string, unknown>;
  expect(beforeFm.kind).toBe('approval');
  expect(beforeFm.target_agent).toBe('drafter');

  const updated = await updateComment({
    workspace: seed.workspace,
    project: seed.project,
    existing: comment,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: '@reviewer approved — actually you should ship it',
  });

  const afterFm = updated.frontmatter as Record<string, unknown>;
  expect(afterFm.kind).toBe('approval');
  expect(afterFm.target_agent).toBe('drafter');
});

// -----------------------------------------------------------------------------
// deleteComment — author-only + soft delete + event
// -----------------------------------------------------------------------------

test('deleteComment rejects non-author with COMMENT_AUTHOR_ONLY', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const comment = await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: 'mine',
  });
  const bob = await seedMember(db, seed.workspace, 'bob@test.local', 'Bob');

  let thrown: unknown = null;
  try {
    await deleteComment({
      workspace: seed.workspace,
      project: seed.project,
      existing: comment,
      authorContext: userContext(bob),
      actor: bob.id,
    });
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(HTTPError);
  expect((thrown as HTTPError).code).toBe('COMMENT_AUTHOR_ONLY');
});

test('deleteComment soft-deletes: row stays, body blanked, deleted_at set, comment.deleted fires', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const comment = await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: 'goodbye',
  });

  const out = await deleteComment({
    workspace: seed.workspace,
    project: seed.project,
    existing: comment,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
  });

  expect(out.body).toBe('');
  const fm = out.frontmatter as Record<string, unknown>;
  expect(typeof fm.deleted_at).toBe('string');

  // Row still exists.
  const row = await db.query.documents.findFirst({ where: eq(documents.id, comment.id) });
  expect(row).toBeTruthy();
  expect(row!.body).toBe('');

  // Event fired.
  const deletedEvents = await db.query.events.findMany({
    where: and(eq(events.documentId, comment.id), eq(events.kind, 'comment.deleted')),
  });
  expect(deletedEvents.length).toBe(1);
  const payload = deletedEvents[0]!.payload as Record<string, unknown>;
  expect(payload.document_id).toBe(comment.id);
  expect(payload.parent_id).toBe(parent.id);
  expect(payload.author).toBe(`user:${seed.user.id}`);
});

test('deleteComment is idempotent on already-soft-deleted rows', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const comment = await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: 'once is enough',
  });

  // First delete.
  const first = await deleteComment({
    workspace: seed.workspace,
    project: seed.project,
    existing: comment,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
  });
  const firstDeletedAt = (first.frontmatter as Record<string, unknown>).deleted_at as string;

  // Second delete — must be idempotent.
  const second = await deleteComment({
    workspace: seed.workspace,
    project: seed.project,
    existing: first,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
  });

  // deleted_at must not have moved.
  expect((second.frontmatter as Record<string, unknown>).deleted_at).toBe(firstDeletedAt);
  // Body still blank.
  expect(second.body).toBe('');
  // Only ONE comment.deleted event should exist.
  const deletedEvents = await db.query.events.findMany({
    where: and(eq(events.documentId, comment.id), eq(events.kind, 'comment.deleted')),
  });
  expect(deletedEvents.length).toBe(1);
});

// BUG-011 — authorship oracle: the prior shape ran assertAuthor BEFORE the
// idempotency guard, so a non-author calling delete on an already-soft-
// deleted comment got 403 (revealing "agent X is NOT the author"); the
// original author got 200 (revealing "agent X IS the author"). A hostile
// narrowed agent could enumerate slug→authorship across the workspace.
// Fix: idempotency check first, so any caller on an already-soft-deleted
// row gets a no-op response.
test('BUG-011: non-author deleting an already-soft-deleted comment is a no-op (no 403)', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);

  // Author A creates + soft-deletes the comment.
  const comment = await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: 'mine',
  });
  const softDeleted = await deleteComment({
    workspace: seed.workspace,
    project: seed.project,
    existing: comment,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
  });

  // User B (non-author) calls delete on the already-soft-deleted comment.
  // Must NOT throw COMMENT_AUTHOR_ONLY — that 403 leaks authorship.
  const bob = await seedMember(db, seed.workspace, 'bob@test.local', 'Bob');

  let thrown: unknown = null;
  let out: Document | null = null;
  try {
    out = await deleteComment({
      workspace: seed.workspace,
      project: seed.project,
      existing: softDeleted,
      authorContext: userContext(bob),
      actor: bob.id,
    });
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeNull();
  expect(out).not.toBeNull();
  expect(out!.body).toBe('');

  // Still only ONE comment.deleted event in the durable log.
  const deletedEvents = await db.query.events.findMany({
    where: and(eq(events.documentId, comment.id), eq(events.kind, 'comment.deleted')),
  });
  expect(deletedEvents.length).toBe(1);
});

// -----------------------------------------------------------------------------
// getComment
// -----------------------------------------------------------------------------

test('getComment returns the comment when slug matches', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const comment = await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: 'hello',
  });

  const found = await getComment(seed.workspace.id, comment.slug);
  expect(found).toBeTruthy();
  expect(found!.id).toBe(comment.id);
});

test('getComment returns null for unknown slug', async () => {
  const { seed } = await makeTestApp();
  const row = await getComment(seed.workspace.id, 'c-nope');
  expect(row).toBeNull();
});

// -----------------------------------------------------------------------------
// listComments — sort, filters, visibility default
// -----------------------------------------------------------------------------

test('listComments returns newest first', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);

  const c1 = await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: 'first',
  });
  // Sleep briefly to guarantee strictly later createdAt.
  await new Promise((r) => setTimeout(r, 10));
  const c2 = await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: 'second',
  });

  const list = await listComments({ parentId: parent.id });
  expect(list.length).toBe(2);
  expect(list[0]!.id).toBe(c2.id);
  expect(list[1]!.id).toBe(c1.id);
});

test('listComments filterable by single kind', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  await seedAgent(db, seed.workspace, seed.user, 'drafter');

  // One plain comment.
  await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: 'plain',
  });
  // One approval via keyword.
  await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: '@drafter approved',
  });

  const approvals = await listComments({ parentId: parent.id, kind: 'approval' });
  expect(approvals.length).toBe(1);
  expect((approvals[0]!.frontmatter as Record<string, unknown>).kind).toBe('approval');

  const plain = await listComments({ parentId: parent.id, kind: 'comment' });
  expect(plain.length).toBe(1);
  expect((plain[0]!.frontmatter as Record<string, unknown>).kind).toBe('comment');
});

test('listComments default visibility excludes internal rows', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);

  await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: 'normal',
  });
  await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: 'internal',
    visibility: 'internal',
  });

  // Default: internal is hidden.
  const defaultList = await listComments({ parentId: parent.id });
  expect(defaultList.length).toBe(1);
  expect((defaultList[0]!.frontmatter as Record<string, unknown>).visibility).toBe('normal');

  // Explicit: both visible.
  const bothList = await listComments({
    parentId: parent.id,
    visibility: ['normal', 'internal'],
  });
  expect(bothList.length).toBe(2);
});

test('listComments returns soft-deleted rows too', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);

  const c = await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: 'about to die',
  });
  await deleteComment({
    workspace: seed.workspace,
    project: seed.project,
    existing: c,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
  });

  const list = await listComments({ parentId: parent.id });
  expect(list.length).toBe(1);
  expect(list[0]!.body).toBe('');
});

test('listComments since filter excludes earlier rows', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);

  await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: 'old',
  });
  await new Promise((r) => setTimeout(r, 20));
  const cutoff = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 20));
  const c2 = await createComment({
    workspace: seed.workspace,
    project: seed.project,
    parent,
    authorContext: userContext(seed.user),
    actor: seed.user.id,
    body: 'new',
  });

  const list = await listComments({ parentId: parent.id, since: cutoff });
  expect(list.length).toBe(1);
  expect(list[0]!.id).toBe(c2.id);
});
