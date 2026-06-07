/**
 * Service-level tests for the documents service.
 *
 * These don't go through HTTP — they call the service functions directly.
 * The route tests in routes/documents.test.ts cover the HTTP layer; these
 * cover the service contract that Task 12b's MCP server will rely on.
 */

import { test, expect } from 'bun:test';
import { and, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { makeTestApp } from '../test/harness.ts';
import { seedProjectDefaults } from '../lib/seed-project-defaults.ts';
import { apiTokens, documents, events, projects, tables } from '../db/schema.ts';
import type { Document } from '../db/schema.ts';
import { HTTPError } from '../lib/http.ts';
import {
  createDocument,
  deleteDocument,
  findDocumentsInProjects,
  getDocument,
  listDocuments,
  updateDocument,
} from './documents.ts';
import { eventBus } from '../lib/event-bus.ts';

async function getWorkItemsTable(
  db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  projectId: string,
) {
  const t = await db.query.tables.findFirst({
    where: and(eq(tables.projectId, projectId), eq(tables.slug, 'work-items')),
  });
  if (!t) throw new Error('test setup: work-items table missing');
  return t;
}

test('listDocuments returns docs for the given project', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  await createDocument({
    workspace: seed.workspace,
    project: seed.project,
    table,
    actor: seed.user,
    eventActor: seed.user.id,
    token: null,
    input: {
      type: 'work_item',
      title: 'Hello',
      body: '',
      frontmatter: {},
      status: null,
    },
  });
  const { data } = await listDocuments({
    projectId: seed.project.id,
    activeTableId: table.id,
    type: 'work_item',
  });
  expect(data).toHaveLength(1);
  expect(data[0]!.slug).toBe('hello');
});

// Slugs are immutable for ALL document types (Phase 3.x). A retitle changes
// the title only — never the slug — so [[slug]] relation links and backlinks
// stay valid forever. This test PINS the deliberate removal of slug
// regeneration: if anyone re-adds it, this fails loudly.
test('retitling a work_item does NOT change its slug (slugs are immutable)', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const { document } = await createDocument({
    workspace: seed.workspace,
    project: seed.project,
    table,
    actor: seed.user,
    eventActor: seed.user.id,
    token: null,
    input: {
      type: 'work_item',
      title: 'Fix login bug',
      body: '',
      frontmatter: {},
      status: null,
    },
  });
  expect(document.slug).toBe('fix-login-bug');

  const updated = await updateDocument({
    workspace: seed.workspace,
    project: seed.project,
    fallbackTable: table,
    actor: seed.user,
    eventActor: seed.user.id,
    existing: document,
    patch: { title: 'Fix the login bug completely' },
  });
  expect(updated.title).toBe('Fix the login bug completely');
  expect(updated.slug).toBe('fix-login-bug');
});

// Invariant 15 — the required `eventActor` param keeps the FK-write actor
// (the FK-valid human in `actor.id`) separate from the EVENT actor. When an
// agent run passes `eventActor: 'agent:<slug>'`, the emitted `document.updated`
// event must carry the AGENT slug, NOT the human id — that is the exact signal
// the agent-chain autonomy gate (isAgentOriginated) keys on. If a caller's
// agent write silently emitted a human-actored event, the gate would be
// disabled. This test pins the property the now-required param protects.
test('updateDocument with an agent eventActor emits an agent-actored event (autonomy gate preserved)', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const { document } = await createDocument({
    workspace: seed.workspace,
    project: seed.project,
    table,
    actor: seed.user,
    eventActor: seed.user.id,
    token: null,
    input: {
      type: 'work_item',
      title: 'Agent-touched item',
      body: '',
      frontmatter: {},
      status: null,
    },
  });

  await updateDocument({
    workspace: seed.workspace,
    project: seed.project,
    fallbackTable: table,
    actor: seed.user,
    // The FK write still goes to the human (actor.id); the EVENT actor is the agent.
    eventActor: 'agent:_operator',
    existing: document,
    patch: { title: 'Agent retitled this' },
  });

  const latest = await db.query.events.findFirst({
    where: and(
      eq(events.documentId, document.id),
      eq(events.kind, 'document.updated'),
    ),
    orderBy: [desc(events.seq)],
  });
  expect(latest).toBeTruthy();
  // The property the required param protects: event actor is the agent slug,
  // NOT the human user id (which still owns the FK write).
  expect(latest!.actor).toBe('agent:_operator');
  expect(latest!.actor).not.toBe(seed.user.id);
});

// Invariant 15 (create) — same FK-actor/event-actor split as update. An agent
// create passes `eventActor: 'agent:<slug>'`; the FK write goes to the human
// (actor.id) but the `document.created` event must carry the AGENT slug so the
// autonomy gate keys on it. Required param turns omission into a tsc error.
test('createDocument with an agent eventActor emits an agent-actored event (autonomy gate preserved)', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const { document } = await createDocument({
    workspace: seed.workspace,
    project: seed.project,
    table,
    actor: seed.user,
    // FK write → human (actor.id); EVENT actor → agent slug.
    eventActor: 'agent:_operator',
    token: null,
    input: {
      type: 'work_item',
      title: 'Agent-created item',
      body: '',
      frontmatter: {},
      status: null,
    },
  });

  const latest = await db.query.events.findFirst({
    where: and(
      eq(events.documentId, document.id),
      eq(events.kind, 'document.created'),
    ),
    orderBy: [desc(events.seq)],
  });
  expect(latest).toBeTruthy();
  expect(latest!.actor).toBe('agent:_operator');
  expect(latest!.actor).not.toBe(seed.user.id);
});

// Invariant 15 (delete) — delete writes no FK column, but the symmetry keeps
// suppression consistent: an agent delete must emit a `document.deleted` event
// actored by the agent slug, not the human id, so the autonomy gate stays live.
test('deleteDocument with an agent eventActor emits an agent-actored event (autonomy gate preserved)', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const { document } = await createDocument({
    workspace: seed.workspace,
    project: seed.project,
    table,
    actor: seed.user,
    eventActor: seed.user.id,
    token: null,
    input: {
      type: 'work_item',
      title: 'Agent-deleted item',
      body: '',
      frontmatter: {},
      status: null,
    },
  });

  await deleteDocument({
    workspace: seed.workspace,
    project: seed.project,
    actor: seed.user,
    // FK write is irrelevant for delete; EVENT actor → agent slug.
    eventActor: 'agent:_operator',
    existing: document,
  });

  const latest = await db.query.events.findFirst({
    where: and(
      eq(events.documentId, document.id),
      eq(events.kind, 'document.deleted'),
    ),
    orderBy: [desc(events.seq)],
  });
  expect(latest).toBeTruthy();
  expect(latest!.actor).toBe('agent:_operator');
  expect(latest!.actor).not.toBe(seed.user.id);
});

test('retitling an UNTITLED placeholder DOES re-slug (first real name wins, once)', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const { document } = await createDocument({
    workspace: seed.workspace, project: seed.project, table, actor: seed.user, eventActor: seed.user.id, token: null,
    input: { type: 'work_item', title: 'Untitled', body: '', frontmatter: {}, status: null },
  });
  expect(document.slug).toBe('untitled');

  // First real title: placeholder slug adopts it.
  const named = await updateDocument({
    workspace: seed.workspace, project: seed.project, fallbackTable: table, actor: seed.user,
    eventActor: seed.user.id,
    existing: document, patch: { title: 'Onboard new client' },
  });
  expect(named.slug).toBe('onboard-new-client');

  // Second rename: now it's a real slug → immutable, does NOT change again.
  const renamed = await updateDocument({
    workspace: seed.workspace, project: seed.project, fallbackTable: table, actor: seed.user,
    eventActor: seed.user.id,
    existing: named, patch: { title: 'Onboard the new client properly' },
  });
  expect(renamed.slug).toBe('onboard-new-client');
});

test('retitling an untitled-N collision placeholder also re-slugs', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  // First Untitled → 'untitled'; second → 'untitled-2' (collision form is still a placeholder).
  await createDocument({
    workspace: seed.workspace, project: seed.project, table, actor: seed.user, eventActor: seed.user.id, token: null,
    input: { type: 'work_item', title: 'Untitled', body: '', frontmatter: {}, status: null },
  });
  const { document: second } = await createDocument({
    workspace: seed.workspace, project: seed.project, table, actor: seed.user, eventActor: seed.user.id, token: null,
    input: { type: 'work_item', title: 'Untitled', body: '', frontmatter: {}, status: null },
  });
  expect(second.slug).toBe('untitled-2');

  const named = await updateDocument({
    workspace: seed.workspace, project: seed.project, fallbackTable: table, actor: seed.user,
    eventActor: seed.user.id,
    existing: second, patch: { title: 'Real Title' },
  });
  expect(named.slug).toBe('real-title');
});

test('getDocument returns null for unknown slug', async () => {
  const { seed } = await makeTestApp();
  const row = await getDocument(seed.project.id, 'nope');
  expect(row).toBeNull();
});

test('createDocument (workspace-scoped) mints + persists an agent token bound to the agent', async () => {
  const { db, seed } = await makeTestApp();
  const { document, agentTokenPlaintext } = await createDocument({
    workspace: seed.workspace,
    project: null,
    table: null,
    actor: seed.user,
    eventActor: seed.user.id,
    token: null,
    input: {
      type: 'agent',
      title: 'Bot',
      body: '',
      frontmatter: {
        system_prompt: 'help',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        tools: ['list_documents', 'get_document'],
      },
      status: null,
    },
  });
  expect(agentTokenPlaintext).toBeString();
  expect(agentTokenPlaintext!.length).toBeGreaterThan(20);
  const apiTokenId = (document.frontmatter as Record<string, unknown>)['api_token_id'];
  expect(typeof apiTokenId).toBe('string');
  const row = await db.query.apiTokens.findFirst({
    where: eq(apiTokens.id, apiTokenId as string),
  });
  expect(row).toBeTruthy();
  expect(row!.workspaceId).toBe(seed.workspace.id);
  // Phase 2.5: agent_id is set so the cascade FK can revoke on delete.
  expect(row!.agentId).toBe(document.id);
});

test('deleteDocument (workspace-scoped) on agent revokes its api token via cascade', async () => {
  const { db, seed } = await makeTestApp();
  const { document } = await createDocument({
    workspace: seed.workspace,
    project: null,
    table: null,
    actor: seed.user,
    eventActor: seed.user.id,
    token: null,
    input: {
      type: 'agent',
      title: 'Goner',
      body: '',
      frontmatter: {
        system_prompt: 'go',
        model: 'gpt-4o',
        provider: 'openai',
        tools: ['list_documents'],
      },
      status: null,
    },
  });
  const apiTokenId = (document.frontmatter as Record<string, unknown>)[
    'api_token_id'
  ] as string;
  const before = await db.query.apiTokens.findFirst({
    where: eq(apiTokens.id, apiTokenId),
  });
  expect(before).toBeTruthy();

  await deleteDocument({
    workspace: seed.workspace,
    project: null,
    actor: seed.user,
    eventActor: seed.user.id,
    existing: document,
  });

  const after = await db.query.apiTokens.findFirst({
    where: eq(apiTokens.id, apiTokenId),
  });
  expect(after).toBeUndefined();
});

// ----- Phase 2.6 sub-phase D: builtin trigger lock -----

async function seedTrigger(
  db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  workspaceId: string,
  opts: { builtin: boolean; slug?: string },
): Promise<Document> {
  const id = nanoid();
  const slug = opts.slug ?? (opts.builtin ? 'builtin-on-foo' : 'custom-on-foo');
  await db.insert(documents).values({
    id,
    workspaceId,
    projectId: null,
    type: 'trigger',
    slug,
    title: 'Test trigger',
    body: '',
    frontmatter: {
      on_event: 'comment.created',
      schedule: null,
      agent: null,
      enabled: true,
      builtin: opts.builtin,
    },
  });
  const row = await db.query.documents.findFirst({
    where: eq(documents.id, id),
  });
  if (!row) throw new Error('seedTrigger: insert failed');
  return row;
}

test('updateDocument blocks PATCH on builtin trigger fields other than enabled', async () => {
  const { db, seed } = await makeTestApp();
  const trig = await seedTrigger(db, seed.workspace.id, { builtin: true });
  await expect(
    updateDocument({
      workspace: seed.workspace,
      project: null,
      fallbackTable: null,
      actor: seed.user,
      eventActor: seed.user.id,
      existing: trig,
      patch: { frontmatter: { event_filter: { kind: 'foo' } } },
    }),
  ).rejects.toMatchObject({ code: 'BUILTIN_TRIGGER_LOCKED', status: 422 });
});

test('updateDocument allows PATCH on enabled for builtin trigger', async () => {
  const { db, seed } = await makeTestApp();
  const trig = await seedTrigger(db, seed.workspace.id, { builtin: true });
  const updated = await updateDocument({
    workspace: seed.workspace,
    project: null,
    fallbackTable: null,
    actor: seed.user,
    eventActor: seed.user.id,
    existing: trig,
    patch: { frontmatter: { enabled: false } },
  });
  expect((updated.frontmatter as Record<string, unknown>).enabled).toBe(false);
  // Builtin flag is preserved.
  expect((updated.frontmatter as Record<string, unknown>).builtin).toBe(true);
});

// Regression: the UI's slideover diffs frontmatter as a whole object and sends
// the entire frontmatter shape on every save. Toggling Enabled on a builtin
// must succeed even when the PATCH body echoes back all other (unchanged) keys.
test('updateDocument allows full-frontmatter PATCH on builtin trigger if only enabled differs in value', async () => {
  const { db, seed } = await makeTestApp();
  const trig = await seedTrigger(db, seed.workspace.id, { builtin: true });
  const fm = trig.frontmatter as Record<string, unknown>;
  const updated = await updateDocument({
    workspace: seed.workspace,
    project: null,
    fallbackTable: null,
    actor: seed.user,
    eventActor: seed.user.id,
    existing: trig,
    patch: {
      frontmatter: {
        on_event: fm.on_event,
        schedule: fm.schedule,
        agent: fm.agent,
        builtin: fm.builtin,
        enabled: false,
      },
    },
  });
  expect((updated.frontmatter as Record<string, unknown>).enabled).toBe(false);
});

test('updateDocument blocks PATCH on builtin trigger title change', async () => {
  const { db, seed } = await makeTestApp();
  const trig = await seedTrigger(db, seed.workspace.id, { builtin: true });
  await expect(
    updateDocument({
      workspace: seed.workspace,
      project: null,
      fallbackTable: null,
      actor: seed.user,
      eventActor: seed.user.id,
      existing: trig,
      patch: { title: 'Renamed' },
    }),
  ).rejects.toMatchObject({ code: 'BUILTIN_TRIGGER_LOCKED', status: 422 });
});

test('updateDocument blocks PATCH on builtin trigger body change', async () => {
  const { db, seed } = await makeTestApp();
  const trig = await seedTrigger(db, seed.workspace.id, { builtin: true });
  await expect(
    updateDocument({
      workspace: seed.workspace,
      project: null,
      fallbackTable: null,
      actor: seed.user,
      eventActor: seed.user.id,
      existing: trig,
      patch: { body: 'New body' },
    }),
  ).rejects.toMatchObject({ code: 'BUILTIN_TRIGGER_LOCKED', status: 422 });
});

test('updateDocument allows full patch on non-builtin trigger', async () => {
  const { db, seed } = await makeTestApp();
  const trig = await seedTrigger(db, seed.workspace.id, { builtin: false });
  const updated = await updateDocument({
    workspace: seed.workspace,
    project: null,
    fallbackTable: null,
    actor: seed.user,
    eventActor: seed.user.id,
    existing: trig,
    patch: { frontmatter: { event_filter: { kind: 'foo' } } },
  });
  expect(
    (updated.frontmatter as Record<string, unknown>).event_filter,
  ).toMatchObject({ kind: 'foo' });
});

// BUG-016 — trigger PATCH validates the PATCH PAYLOAD against the partial
// schema (so server-managed fields don't trip .strict()), but skips the
// cross-field refine `schedule!==null || on_event!==null`. A PATCH that
// clears the only timing field leaves the doc in a state the create schema
// would have rejected. Dispatch then never fires; the operator sees a
// trigger row with zero runs and no error feedback. Re-validate the merged
// frontmatter against the full schema and reject with INVALID_PATCH.
test('BUG-016: PATCH that clears schedule on schedule-only trigger rejects with INVALID_PATCH', async () => {
  const { db, seed } = await makeTestApp();
  // Seed a non-builtin schedule-only trigger.
  const id = nanoid();
  await db.insert(documents).values({
    id,
    workspaceId: seed.workspace.id,
    projectId: null,
    type: 'trigger',
    slug: 'cron-only',
    title: 'Cron only trigger',
    body: '',
    frontmatter: {
      on_event: null,
      schedule: '0 * * * *',
      agent: 'drafter',
      enabled: true,
      builtin: false,
    },
  });
  const trig = (await db.query.documents.findFirst({
    where: eq(documents.id, id),
  }))!;

  // Cleared schedule, on_event still null → merged trigger has neither.
  await expect(
    updateDocument({
      workspace: seed.workspace,
      project: null,
      fallbackTable: null,
      actor: seed.user,
      eventActor: seed.user.id,
      existing: trig,
      patch: { frontmatter: { schedule: null } },
    }),
  ).rejects.toMatchObject({ code: 'INVALID_PATCH', status: 422 });
});

test('BUG-016: PATCH that clears on_event on event-only trigger rejects with INVALID_PATCH', async () => {
  const { db, seed } = await makeTestApp();
  const id = nanoid();
  await db.insert(documents).values({
    id,
    workspaceId: seed.workspace.id,
    projectId: null,
    type: 'trigger',
    slug: 'event-only',
    title: 'Event only trigger',
    body: '',
    frontmatter: {
      on_event: 'comment.created',
      schedule: null,
      agent: 'drafter',
      enabled: true,
      builtin: false,
    },
  });
  const trig = (await db.query.documents.findFirst({
    where: eq(documents.id, id),
  }))!;

  await expect(
    updateDocument({
      workspace: seed.workspace,
      project: null,
      fallbackTable: null,
      actor: seed.user,
      eventActor: seed.user.id,
      existing: trig,
      patch: { frontmatter: { on_event: null } },
    }),
  ).rejects.toMatchObject({ code: 'INVALID_PATCH', status: 422 });
});

test('BUG-016: switching from schedule-only to event-only (one valid → another valid) succeeds', async () => {
  const { db, seed } = await makeTestApp();
  const id = nanoid();
  await db.insert(documents).values({
    id,
    workspaceId: seed.workspace.id,
    projectId: null,
    type: 'trigger',
    slug: 'switching',
    title: 'Switching trigger',
    body: '',
    frontmatter: {
      on_event: null,
      schedule: '0 * * * *',
      agent: 'drafter',
      enabled: true,
      builtin: false,
    },
  });
  const trig = (await db.query.documents.findFirst({
    where: eq(documents.id, id),
  }))!;

  // Clear schedule AND set on_event in the same PATCH — merged is valid
  // (Folio's PATCH convention: `null` value DELETES the key from frontmatter,
  // so after the merge `schedule` is absent and on_event is present).
  const updated = await updateDocument({
    workspace: seed.workspace,
    project: null,
    fallbackTable: null,
    actor: seed.user,
    eventActor: seed.user.id,
    existing: trig,
    patch: { frontmatter: { schedule: null, on_event: 'comment.created' } },
  });
  const fm = updated.frontmatter as Record<string, unknown>;
  expect(fm.schedule).toBeUndefined();
  expect(fm.on_event).toBe('comment.created');
});

test('deleteDocument blocks delete on builtin trigger', async () => {
  const { db, seed } = await makeTestApp();
  const trig = await seedTrigger(db, seed.workspace.id, { builtin: true });
  let caught: unknown;
  try {
    await deleteDocument({
      workspace: seed.workspace,
      project: null,
      actor: seed.user,
      eventActor: seed.user.id,
      existing: trig,
    });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(HTTPError);
  expect((caught as HTTPError).code).toBe('BUILTIN_TRIGGER_LOCKED');
  expect((caught as HTTPError).status).toBe(422);
  // Row still exists.
  const still = await db.query.documents.findFirst({
    where: eq(documents.id, trig.id),
  });
  expect(still).toBeTruthy();
});

test('deleteDocument allows delete on non-builtin trigger', async () => {
  const { db, seed } = await makeTestApp();
  const trig = await seedTrigger(db, seed.workspace.id, { builtin: false });
  await deleteDocument({
    workspace: seed.workspace,
    project: null,
    actor: seed.user,
    eventActor: seed.user.id,
    existing: trig,
  });
  const gone = await db.query.documents.findFirst({
    where: eq(documents.id, trig.id),
  });
  expect(gone).toBeUndefined();
});

// ---------------------------------------------------------------------------
// F8 — deleting a work_item/page must cascade to its comments.
//
// documents.parent_id has no SQL foreign key, so app-layer deleteDocument is
// responsible for purging child comment rows. Without this, comment rows
// survive their parent, surface in markdown exports, and accumulate forever.
// ---------------------------------------------------------------------------

test('F8: deleteDocument(work_item) cascades to remove its comment children', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);

  // Create the parent + 3 comments via the service layer.
  const parent = await createDocument({
    workspace: seed.workspace,
    project: seed.project,
    table,
    actor: seed.user,
    eventActor: seed.user.id,
    token: null,
    isTableScopedUrl: false,
    input: { type: 'work_item', title: 'Parent', body: '', frontmatter: {}, status: null },
  });

  const commentIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const id = nanoid();
    await db.insert(documents).values({
      id,
      workspaceId: seed.workspace.id,
      projectId: seed.project.id,
      tableId: null,
      type: 'comment',
      slug: `c-${id}`,
      title: `Comment ${i}`,
      status: null,
      body: `comment body ${i}`,
      parentId: parent.document.id,
      frontmatter: { author: `user:${seed.user.id}`, kind: 'comment', visibility: 'normal', mentions: [] },
      createdBy: seed.user.id,
      updatedBy: seed.user.id,
    });
    commentIds.push(id);
  }

  // Sanity: 3 comments exist with parent_id matching.
  const before = await db.query.documents.findMany({
    where: and(eq(documents.parentId, parent.document.id), eq(documents.type, 'comment')),
  });
  expect(before).toHaveLength(3);

  // Delete the parent.
  await deleteDocument({
    workspace: seed.workspace,
    project: seed.project,
    actor: seed.user,
    eventActor: seed.user.id,
    existing: parent.document,
  });

  // Parent gone.
  const parentGone = await db.query.documents.findFirst({
    where: eq(documents.id, parent.document.id),
  });
  expect(parentGone).toBeUndefined();

  // Children gone too — no orphans.
  const after = await db.query.documents.findMany({
    where: and(eq(documents.parentId, parent.document.id), eq(documents.type, 'comment')),
  });
  expect(after).toHaveLength(0);

  // Lookup each child by id — all gone.
  for (const id of commentIds) {
    const found = await db.query.documents.findFirst({ where: eq(documents.id, id) });
    expect(found).toBeUndefined();
  }
});

test('H8: deleteDocument(page) cascades GRANDCHILDREN recursively (3 levels deep)', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);

  // Build A → B → C
  const a = await createDocument({
    workspace: seed.workspace, project: seed.project, table, actor: seed.user, eventActor: seed.user.id, token: null,
    isTableScopedUrl: false,
    input: { type: 'page', title: 'A', body: '', frontmatter: {}, status: null },
  });
  const bId = nanoid();
  await db.insert(documents).values({
    id: bId,
    workspaceId: seed.workspace.id, projectId: seed.project.id, tableId: null,
    type: 'page', slug: `b-${bId}`, title: 'B', status: null, body: '',
    parentId: a.document.id, frontmatter: {},
    createdBy: seed.user.id, updatedBy: seed.user.id,
  });
  const cId = nanoid();
  await db.insert(documents).values({
    id: cId,
    workspaceId: seed.workspace.id, projectId: seed.project.id, tableId: null,
    type: 'page', slug: `c-${cId}`, title: 'C', status: null, body: '',
    parentId: bId, frontmatter: {},
    createdBy: seed.user.id, updatedBy: seed.user.id,
  });
  // Also add a comment grandchild of B (mixed types).
  const cmtId = nanoid();
  await db.insert(documents).values({
    id: cmtId,
    workspaceId: seed.workspace.id, projectId: seed.project.id, tableId: null,
    type: 'comment', slug: `cmt-${cmtId}`, title: '', status: null, body: 'on B',
    parentId: bId,
    frontmatter: { author: `user:${seed.user.id}`, kind: 'comment', visibility: 'normal', mentions: [] },
    createdBy: seed.user.id, updatedBy: seed.user.id,
  });

  // Delete A. Recursive cascade should remove B, C, and the comment.
  await deleteDocument({
    workspace: seed.workspace, project: seed.project, actor: seed.user,
    eventActor: seed.user.id,
    existing: a.document,
  });

  for (const id of [a.document.id, bId, cId, cmtId]) {
    const found = await db.query.documents.findFirst({ where: eq(documents.id, id) });
    expect(found).toBeUndefined();
  }
});

test('G8: deleteDocument(page) cascades nested page children too', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);

  // Parent page.
  const parent = await createDocument({
    workspace: seed.workspace, project: seed.project, table, actor: seed.user, eventActor: seed.user.id, token: null,
    isTableScopedUrl: false,
    input: { type: 'page', title: 'Parent Page', body: '', frontmatter: {}, status: null },
  });

  // Nested page child via direct insert (mirrors what PATCH parentId would do).
  const childId = nanoid();
  await db.insert(documents).values({
    id: childId,
    workspaceId: seed.workspace.id,
    projectId: seed.project.id,
    tableId: null,
    type: 'page',
    slug: `child-${childId}`,
    title: 'Child Page',
    status: null,
    body: 'nested content',
    parentId: parent.document.id,
    frontmatter: {},
    createdBy: seed.user.id,
    updatedBy: seed.user.id,
  });

  await deleteDocument({
    workspace: seed.workspace, project: seed.project, actor: seed.user,
    eventActor: seed.user.id,
    existing: parent.document,
  });

  // Both parent and child gone.
  const parentGone = await db.query.documents.findFirst({ where: eq(documents.id, parent.document.id) });
  expect(parentGone).toBeUndefined();
  const childGone = await db.query.documents.findFirst({ where: eq(documents.id, childId) });
  expect(childGone).toBeUndefined();
});

// BUG-010 — the recursive cascade hard-DELETEd descendants in one SQL
// statement and emitted only the top-level document.deleted event. Comment
// rows by other authors vanished with no `comment.deleted` signal; UIs
// caching the thread stale-display indefinitely, and Phase 3 audit-log
// records mis-count the deletion scope. Cascade now walks descendants in
// TS first and emits per-row events inside the same tx (transactional with
// the parent delete).
test('BUG-010: cascade emits per-descendant events (comment.deleted + document.deleted)', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);

  // Two distinct comment authors so we can assert author signal is preserved
  // on cascade. user2 is just a synthetic id stamped into frontmatter.author.
  const otherAuthor = 'user:u-other';

  const parent = await createDocument({
    workspace: seed.workspace, project: seed.project, table, actor: seed.user, eventActor: seed.user.id, token: null,
    isTableScopedUrl: false,
    input: { type: 'work_item', title: 'Parent', body: '', frontmatter: {}, status: null },
  });

  // 2 comments by different authors + 1 nested page (with its own comment).
  const cmt1Id = nanoid();
  await db.insert(documents).values({
    id: cmt1Id,
    workspaceId: seed.workspace.id, projectId: seed.project.id, tableId: null,
    type: 'comment', slug: `c1-${cmt1Id}`, title: '', status: null, body: 'first',
    parentId: parent.document.id,
    frontmatter: { author: `user:${seed.user.id}`, kind: 'comment', visibility: 'normal', mentions: [] },
    createdBy: seed.user.id, updatedBy: seed.user.id,
  });
  const cmt2Id = nanoid();
  await db.insert(documents).values({
    id: cmt2Id,
    workspaceId: seed.workspace.id, projectId: seed.project.id, tableId: null,
    type: 'comment', slug: `c2-${cmt2Id}`, title: '', status: null, body: 'second',
    parentId: parent.document.id,
    frontmatter: { author: otherAuthor, kind: 'comment', visibility: 'normal', mentions: [] },
    createdBy: seed.user.id, updatedBy: seed.user.id,
  });
  const nestedPageId = nanoid();
  await db.insert(documents).values({
    id: nestedPageId,
    workspaceId: seed.workspace.id, projectId: seed.project.id, tableId: null,
    type: 'page', slug: `p-${nestedPageId}`, title: 'Nested', status: null, body: '',
    parentId: parent.document.id, frontmatter: {},
    createdBy: seed.user.id, updatedBy: seed.user.id,
  });
  const nestedCmtId = nanoid();
  await db.insert(documents).values({
    id: nestedCmtId,
    workspaceId: seed.workspace.id, projectId: seed.project.id, tableId: null,
    type: 'comment', slug: `nc-${nestedCmtId}`, title: '', status: null, body: 'nested cmt',
    parentId: nestedPageId,
    frontmatter: { author: `user:${seed.user.id}`, kind: 'comment', visibility: 'normal', mentions: [] },
    createdBy: seed.user.id, updatedBy: seed.user.id,
  });

  // Subscribe to the bus and capture every event in the workspace.
  type Captured = { kind: string; documentId?: string | null; payload?: unknown };
  const captured: Captured[] = [];
  const unsub = eventBus.subscribe(seed.workspace.id, undefined, (e) => {
    captured.push({ kind: e.kind, documentId: e.documentId, payload: e.payload });
  });

  await deleteDocument({
    workspace: seed.workspace, project: seed.project, actor: seed.user,
    eventActor: seed.user.id,
    existing: parent.document,
  });
  unsub();

  // All 4 descendant rows + the parent itself must have emitted a delete event.
  const commentEvents = captured.filter((e) => e.kind === 'comment.deleted');
  const docEvents = captured.filter((e) => e.kind === 'document.deleted');

  // Both top-level comments + the nested-page comment → 3 comment.deleted.
  expect(commentEvents).toHaveLength(3);
  // The nested page + the parent itself → 2 document.deleted.
  expect(docEvents).toHaveLength(2);

  const commentIds = new Set(commentEvents.map((e) => e.documentId));
  expect(commentIds.has(cmt1Id)).toBe(true);
  expect(commentIds.has(cmt2Id)).toBe(true);
  expect(commentIds.has(nestedCmtId)).toBe(true);

  const docIds = new Set(docEvents.map((e) => e.documentId));
  expect(docIds.has(nestedPageId)).toBe(true);
  expect(docIds.has(parent.document.id)).toBe(true);

  // Author payload is preserved on cascaded comment events (so a Phase-3
  // audit-log subscriber gets the same shape as direct-delete).
  const cmt2Event = commentEvents.find((e) => e.documentId === cmt2Id);
  const cmt2Payload = cmt2Event!.payload as { author?: string };
  expect(cmt2Payload.author).toBe(otherAuthor);
});

test('F8: deleting a non-parent doc does not collateral-delete unrelated comments', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);

  // Two unrelated parents, each with its own comment.
  const parentA = await createDocument({
    workspace: seed.workspace, project: seed.project, table, actor: seed.user, eventActor: seed.user.id, token: null,
    isTableScopedUrl: false,
    input: { type: 'work_item', title: 'A', body: '', frontmatter: {}, status: null },
  });
  const parentB = await createDocument({
    workspace: seed.workspace, project: seed.project, table, actor: seed.user, eventActor: seed.user.id, token: null,
    isTableScopedUrl: false,
    input: { type: 'work_item', title: 'B', body: '', frontmatter: {}, status: null },
  });
  const commentB = nanoid();
  await db.insert(documents).values({
    id: commentB,
    workspaceId: seed.workspace.id,
    projectId: seed.project.id,
    tableId: null,
    type: 'comment',
    slug: `c-${commentB}`,
    title: 'Comment B',
    status: null,
    body: 'belongs to B',
    parentId: parentB.document.id,
    frontmatter: { author: `user:${seed.user.id}`, kind: 'comment', visibility: 'normal', mentions: [] },
    createdBy: seed.user.id,
    updatedBy: seed.user.id,
  });

  // Delete A. B's comment must survive.
  await deleteDocument({
    workspace: seed.workspace, project: seed.project, actor: seed.user,
    eventActor: seed.user.id,
    existing: parentA.document,
  });
  const stillThere = await db.query.documents.findFirst({ where: eq(documents.id, commentB) });
  expect(stillThere).toBeTruthy();
});

// FIX #6 — `model: ''` clears the key on merge (empty string is "absent", not a
// stored literal ''). The agent schema preprocesses '' → undefined so the PATCH
// validates, but the merge loop only deletes on `=== null`, so '' would persist.
test("PATCH agent with model: '' clears the key (does not persist empty string)", async () => {
  const { seed } = await makeTestApp();
  const { document } = await createDocument({
    workspace: seed.workspace, project: null, table: null, actor: seed.user, eventActor: seed.user.id, token: null,
    input: {
      type: 'agent', title: 'EmptyModel', body: '', status: null,
      frontmatter: {
        model: 'claude-sonnet-4-6', provider: 'anthropic',
        tools: ['list_documents'],
      },
    },
  });
  const updated = await updateDocument({
    workspace: seed.workspace, project: null, fallbackTable: null, actor: seed.user,
    eventActor: seed.user.id,
    existing: document,
    // Switch to the modelless claude-code provider AND clear the model together,
    // so the post-merge superRefine (FIX #1) is satisfied.
    patch: { frontmatter: { provider: 'claude-code', model: '' } },
  });
  const fm = updated.frontmatter as Record<string, unknown>;
  expect(fm.model).toBeUndefined();
  expect('model' in fm ? fm.model : undefined).toBeUndefined();
});

// FIX #1 — the agent superRefine ("model is required for API providers") is
// stripped by `.innerType().partial()` on the PATCH-payload validation, so a
// PATCH clearing the model on an API-provider agent slips through and persists
// a modelless API agent that only fails at run time. Re-check post-merge.
test('FIX#1: PATCH clearing model on an API-provider agent rejects with INVALID_PATCH', async () => {
  const { seed } = await makeTestApp();
  const { document } = await createDocument({
    workspace: seed.workspace, project: null, table: null, actor: seed.user, eventActor: seed.user.id, token: null,
    input: {
      type: 'agent', title: 'ApiAgent', body: '', status: null,
      frontmatter: {
        model: 'claude-sonnet-4-6', provider: 'anthropic',
        tools: ['list_documents'],
      },
    },
  });
  await expect(
    updateDocument({
      workspace: seed.workspace, project: null, fallbackTable: null, actor: seed.user,
      eventActor: seed.user.id,
      existing: document,
      patch: { frontmatter: { model: null } },
    }),
  ).rejects.toMatchObject({ code: 'INVALID_PATCH', status: 422 });
});

test('FIX#1: PATCH clearing model on a claude-code agent succeeds (no model required)', async () => {
  const { seed } = await makeTestApp();
  const { document } = await createDocument({
    workspace: seed.workspace, project: null, table: null, actor: seed.user, eventActor: seed.user.id, token: null,
    input: {
      type: 'agent', title: 'CcAgent', body: '', status: null,
      frontmatter: {
        provider: 'claude-code',
        tools: ['list_documents'],
      },
    },
  });
  const updated = await updateDocument({
    workspace: seed.workspace, project: null, fallbackTable: null, actor: seed.user,
    eventActor: seed.user.id,
    existing: document,
    patch: { frontmatter: { model: null } },
  });
  const fm = updated.frontmatter as Record<string, unknown>;
  expect(fm.model).toBeUndefined();
  expect(fm.provider).toBe('claude-code');
});

// FIX #3 — placeholder re-slug is keyed on PROVENANCE, not just slug text shape.
// A doc whose slug is placeholder-shaped (`untitled-5`) but whose TITLE is a real
// 'Untitled-5' (user deliberately named it that) must NOT silently move its slug
// on a later retitle — that would break [[slug]] links (no rename cascade exists).
test('FIX#3: a placeholder-SHAPED slug with a real (non-seed) title does NOT re-slug', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  // Seed a work_item whose slug is placeholder-shaped but title is a real name.
  const id = nanoid();
  await db.insert(documents).values({
    id,
    workspaceId: seed.workspace.id,
    projectId: seed.project.id,
    tableId: table.id,
    type: 'work_item',
    slug: 'untitled-5',
    title: 'Untitled-5',
    status: null,
    body: '',
    frontmatter: {},
    createdBy: seed.user.id,
    updatedBy: seed.user.id,
  });
  const existing = (await db.query.documents.findFirst({
    where: eq(documents.id, id),
  }))! as Document;

  const updated = await updateDocument({
    workspace: seed.workspace, project: seed.project, fallbackTable: table, actor: seed.user,
    eventActor: seed.user.id,
    existing,
    patch: { title: 'Whatever' },
  });
  expect(updated.title).toBe('Whatever');
  expect(updated.slug).toBe('untitled-5');
});

test('listDocuments titleQuery matches title substring, case-insensitive', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  await createDocument({
    workspace: seed.workspace,
    project: seed.project,
    table,
    actor: seed.user,
    eventActor: seed.user.id,
    token: null,
    input: {
      type: 'work_item',
      title: 'Hosting setup on Combell',
      body: '',
      frontmatter: {},
      status: null,
    },
  });
  await createDocument({
    workspace: seed.workspace,
    project: seed.project,
    table,
    actor: seed.user,
    eventActor: seed.user.id,
    token: null,
    input: {
      type: 'work_item',
      title: 'Homepage hero block',
      body: '',
      frontmatter: {},
      status: null,
    },
  });

  const hit = await listDocuments({ projectId: seed.project.id, titleQuery: 'combell' });
  expect(hit.data.map((d) => d.title)).toEqual(['Hosting setup on Combell']);

  const miss = await listDocuments({ projectId: seed.project.id, titleQuery: 'zzz-nope' });
  expect(miss.data).toEqual([]);
});

test('listDocuments with no type excludes comment and agent_run', async () => {
  const { db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);

  // Create a work_item via the normal service to get a real id.
  const { document: workItem } = await createDocument({
    workspace: seed.workspace,
    project: seed.project,
    table,
    actor: seed.user,
    eventActor: seed.user.id,
    token: null,
    input: { type: 'work_item', title: 'Task one', body: '', frontmatter: {}, status: null },
  });

  // Seed a page row directly (mirrors the pattern used by nested-page tests).
  const pageId = nanoid();
  await db.insert(documents).values({
    id: pageId,
    workspaceId: seed.workspace.id,
    projectId: seed.project.id,
    tableId: null,
    type: 'page',
    slug: `wiki-page-${pageId}`,
    title: 'Wiki page',
    status: null,
    body: '',
    frontmatter: {},
    createdBy: seed.user.id,
    updatedBy: seed.user.id,
  });

  // Seed a comment row directly — createDocument rejects type:'comment'
  // (comments go through their own service). Mirror the seedTrigger pattern.
  // The CHECK constraint requires parentId IS NOT NULL for comment rows.
  const commentId = nanoid();
  await db.insert(documents).values({
    id: commentId,
    workspaceId: seed.workspace.id,
    projectId: seed.project.id,
    parentId: workItem.id,
    type: 'comment' as Document['type'],
    slug: `comment-${commentId}`,
    title: 'Re: something',
    body: 'a reply',
    frontmatter: {},
    createdBy: seed.user.id,
    updatedBy: seed.user.id,
  });

  const { data } = await listDocuments({ projectId: seed.project.id });
  const types = new Set(data.map((d) => d.type));

  expect(types.has('comment')).toBe(false);
  expect(types.has('agent_run')).toBe(false);
  expect(types.has('work_item')).toBe(true);
  expect(types.has('page')).toBe(true);
});

test('findDocumentsInProjects searches only the given project ids', async () => {
  const { db, seed } = await makeTestApp();
  const tableA = await getWorkItemsTable(db, seed.project.id);

  // Second project in the SAME workspace — mirror the harness: insert a
  // projects row then seedProjectDefaults so it gets a work-items table.
  const projectBId = nanoid();
  await db.insert(projects).values({
    id: projectBId,
    workspaceId: seed.workspace.id,
    slug: 'ops',
    name: 'Ops',
  });
  await seedProjectDefaults(db, projectBId);
  const projectB = (await db.query.projects.findFirst({
    where: eq(projects.id, projectBId),
  }))!;
  const tableB = await getWorkItemsTable(db, projectBId);

  await createDocument({
    workspace: seed.workspace,
    project: seed.project,
    table: tableA,
    actor: seed.user,
    eventActor: seed.user.id,
    token: null,
    input: { type: 'work_item', title: 'Combell hosting', body: '', frontmatter: {}, status: null },
  });
  await createDocument({
    workspace: seed.workspace,
    project: projectB,
    table: tableB,
    actor: seed.user,
    eventActor: seed.user.id,
    token: null,
    input: { type: 'work_item', title: 'Combell billing', body: '', frontmatter: {}, status: null },
  });

  const res = await findDocumentsInProjects({
    projectIds: [seed.project.id],
    titleQuery: 'combell',
    limit: 25,
  });
  expect(res.map((d) => d.projectId)).toEqual([seed.project.id]); // B excluded
  expect(res[0]!.title).toBe('Combell hosting');
});
