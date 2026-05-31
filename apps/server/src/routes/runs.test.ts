/**
 * Phase 3 Sub-phase D (Task D-1) — routes/runs.ts HTTP transport tests.
 *
 * Six verbs:
 *   GET    /api/v1/w/:wslug/p/:pslug/runs        (pScope, list)
 *   GET    /api/v1/w/:wslug/runs/:runId          (wScope, single)
 *   POST   /api/v1/w/:wslug/runs                 (wScope, create)
 *   POST   /api/v1/w/:wslug/runs/:runId/cancel   (wScope)
 *   POST   /api/v1/w/:wslug/runs/:runId/retry    (wScope)
 *   GET    /api/v1/w/:wslug/provider-health      (wScope)
 *
 * Bound threat-model mitigations exercised: 54 (autonomy gate), 55 (allow-list
 * on parent), 56 (idempotency on create), 58 (id re-scope), 59 (input-comment
 * ordering), 63 (retry idempotency).
 */

import { afterEach, expect, test } from 'bun:test';
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
  memberships,
  projects,
  tables,
  workspaces,
} from '../db/schema.ts';
import { env } from '../env.ts';
import { toolsToScopes } from '../lib/agent-schema.ts';
import { newApiToken } from '../lib/auth.ts';
import { eventBus } from '../lib/event-bus.ts';
import { seedProjectDefaults } from '../lib/seed-project-defaults.ts';
import { createRun, ensureRunsTable, nextChainId } from '../services/agent-runs.ts';
import { listComments } from '../services/comments.ts';
import { makeTestApp } from '../test/harness.ts';

type DB = Awaited<ReturnType<typeof makeTestApp>>['db'];

afterEach(() => eventBus.__clear());

// ----- seed helpers -----

async function getWorkItemsTable(db: DB, projectId: string): Promise<TableEntity> {
  const t = await db.query.tables.findFirst({
    where: and(eq(tables.projectId, projectId), eq(tables.slug, 'work-items')),
  });
  if (!t) throw new Error('test setup: work-items table missing');
  return t;
}

async function seedWorkItem(
  db: DB,
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

/**
 * Seed an agent doc + matching api_token. Returns the agent doc and the
 * plaintext bearer token (when an agent-bound bearer is needed). The token's
 * scopes are derived from `tools` via toolsToScopes — pass create_agent for
 * agents:write, list_documents for documents:read.
 */
async function seedAgent(
  db: DB,
  workspace: Workspace,
  user: User,
  slug: string,
  opts: { projects?: string[]; tools?: string[] } = {},
): Promise<{ agent: Document; token: string }> {
  const id = nanoid();
  const { token, hash } = newApiToken();
  const apiTokenId = nanoid();
  const tools = opts.tools ?? ['create_agent', 'list_documents'];
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
    // an empty body, so seed a non-empty one.
    body: 'You are a helper.',
    frontmatter: {
      system_prompt: 'You are a helper.',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      tools,
      projects: opts.projects ?? ['*'],
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
    scopes: toolsToScopes(tools),
    agentId: id,
    createdBy: user.id,
  });
  const agent = await db.query.documents.findFirst({ where: eq(documents.id, id) });
  if (!agent) throw new Error('test setup: agent insert did not round-trip');
  return { agent, token };
}

/** Create a run row via the real service (mirrors createRun's production path). */
async function seedRun(
  db: DB,
  workspace: Workspace,
  project: Project,
  agent: Document,
  actor: User,
  parent: Document,
): Promise<Document> {
  const runsTable = await db.transaction(async (tx) =>
    ensureRunsTable(tx, { workspaceId: workspace.id, projectId: project.id }),
  );
  const { document } = await createRun({
    workspace,
    project,
    runsTable,
    agent,
    actor,
    input: {
      parentDocumentId: parent.id,
      firedBy: 'manual',
      chainId: nextChainId({ firedBy: 'manual' }),
      triggerId: null,
    },
  });
  return document;
}

// ----- GET /provider-health -----

test('GET /provider-health returns camelCase snapshot for 4 providers (session)', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/provider-health', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const { data } = await res.json();
  expect(Object.keys(data).sort()).toEqual(['anthropic', 'ollama', 'openai', 'openrouter']);
  expect(data.anthropic).toEqual({ status: 'healthy', consecutiveFailures: 0 });
});

// ----- POST /runs happy path (session) -----

test('POST /runs creates a planning run (session) → 201', async () => {
  const { app, db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const { agent } = await seedAgent(db, seed.workspace, seed.user, 'helper');

  const res = await app.request('/api/v1/w/acme/runs', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_slug: 'helper', parent_slug: parent.slug }),
  });
  expect(res.status).toBe(201);
  const { data } = await res.json();
  expect(data.status).toBe('planning');
  expect(typeof data.run_id).toBe('string');

  const row = await db.query.documents.findFirst({ where: eq(documents.id, data.run_id) });
  expect(row?.type).toBe('agent_run');
  expect(row?.status).toBe('planning');
});

test('POST /runs with input posts a comment to the parent before the run (m59 happy)', async () => {
  const { app, db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  await seedAgent(db, seed.workspace, seed.user, 'helper');

  const res = await app.request('/api/v1/w/acme/runs', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_slug: 'helper', parent_slug: parent.slug, input: 'do the thing' }),
  });
  expect(res.status).toBe(201);
  const comments = await listComments({ parentId: parent.id });
  expect(comments.length).toBe(1);
  expect(comments[0]?.body).toBe('do the thing');
});

test('POST /runs → 404 PARENT_NOT_FOUND for missing parent', async () => {
  const { app, db, seed } = await makeTestApp();
  await seedAgent(db, seed.workspace, seed.user, 'helper');
  const res = await app.request('/api/v1/w/acme/runs', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_slug: 'helper', parent_slug: 'nope-xyz' }),
  });
  expect(res.status).toBe(404);
  expect((await res.json()).error.code).toBe('PARENT_NOT_FOUND');
});

test('POST /runs → 404 AGENT_NOT_FOUND for missing agent', async () => {
  const { app, db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const res = await app.request('/api/v1/w/acme/runs', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_slug: 'ghost', parent_slug: parent.slug }),
  });
  expect(res.status).toBe(404);
  expect((await res.json()).error.code).toBe('AGENT_NOT_FOUND');
});

// ----- m56 idempotency -----

test('POST /runs twice for same (parent,agent) → 409 RUN_ALREADY_ACTIVE (m56)', async () => {
  const { app, db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  await seedAgent(db, seed.workspace, seed.user, 'helper');
  const body = JSON.stringify({ agent_slug: 'helper', parent_slug: parent.slug });

  const r1 = await app.request('/api/v1/w/acme/runs', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body,
  });
  expect(r1.status).toBe(201);
  const r2 = await app.request('/api/v1/w/acme/runs', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body,
  });
  expect(r2.status).toBe(409);
  expect((await r2.json()).error.code).toBe('RUN_ALREADY_ACTIVE');
});

test('POST /runs duplicate-active WITH input → 409 and posts NO new comment (m56 ordering)', async () => {
  const { app, db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  await seedAgent(db, seed.workspace, seed.user, 'helper');
  const body = JSON.stringify({
    agent_slug: 'helper',
    parent_slug: parent.slug,
    input: 'do the thing',
  });

  // First create succeeds and posts its input comment.
  const r1 = await app.request('/api/v1/w/acme/runs', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body,
  });
  expect(r1.status).toBe(201);
  const before = await listComments({ parentId: parent.id });
  expect(before.length).toBe(1);

  // Second (duplicate-active) create WITH input must 409 BEFORE side-effecting a
  // comment — the early idempotency check governs ordering. Comment count holds.
  const r2 = await app.request('/api/v1/w/acme/runs', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body,
  });
  expect(r2.status).toBe(409);
  expect((await r2.json()).error.code).toBe('RUN_ALREADY_ACTIVE');

  const after = await listComments({ parentId: parent.id });
  expect(after.length).toBe(1); // unchanged — the rejected POST left no stray comment
});

// ----- m54 autonomy gate -----

test('m54: agent-bound bearer POST with chains OFF → 403 + suppressed event + zero runs', async () => {
  const { app, db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const { token } = await seedAgent(db, seed.workspace, seed.user, 'helper');

  const seen: string[] = [];
  const unsub = eventBus.subscribe(seed.workspace.id, undefined, (e) => {
    if (e.kind === 'agent.chain.suppressed') seen.push(e.kind);
  });

  const prev = env.FOLIO_AGENT_CHAINS_ENABLED;
  env.FOLIO_AGENT_CHAINS_ENABLED = false;
  try {
    const res = await app.request('/api/v1/w/acme/runs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_slug: 'helper', parent_slug: parent.slug }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('AGENT_CHAINS_DISABLED');
  } finally {
    env.FOLIO_AGENT_CHAINS_ENABLED = prev;
    unsub();
  }

  const runs = await db.query.documents.findMany({ where: eq(documents.type, 'agent_run') });
  expect(runs.length).toBe(0);
  expect(seen).toEqual(['agent.chain.suppressed']);
});

test('m54: human PAT (agentId null) POST with chains OFF → 201 (gate allows human PATs)', async () => {
  const { app, db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  await seedAgent(db, seed.workspace, seed.user, 'helper');

  // Mint a HUMAN PAT: agentId null, createdBy a real user so the owner-resolution
  // path (token.createdBy → user) lets createRun's actor resolve.
  const { token, hash } = newApiToken();
  const tools = ['create_agent', 'list_documents']; // → agents:write + documents:read
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    name: 'human-pat',
    tokenHash: hash,
    scopes: toolsToScopes(tools),
    agentId: null,
    createdBy: seed.user.id,
  });

  const prev = env.FOLIO_AGENT_CHAINS_ENABLED;
  env.FOLIO_AGENT_CHAINS_ENABLED = false; // chains OFF — must NOT block a human PAT
  try {
    const res = await app.request('/api/v1/w/acme/runs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_slug: 'helper', parent_slug: parent.slug }),
    });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.status).toBe('planning');
  } finally {
    env.FOLIO_AGENT_CHAINS_ENABLED = prev;
  }

  const runs = await db.query.documents.findMany({ where: eq(documents.type, 'agent_run') });
  expect(runs.length).toBe(1);
});

test('m54: agent-bound bearer POST with chains ON → 201 (one run)', async () => {
  const { app, db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const { token } = await seedAgent(db, seed.workspace, seed.user, 'helper');

  const prev = env.FOLIO_AGENT_CHAINS_ENABLED;
  env.FOLIO_AGENT_CHAINS_ENABLED = true;
  try {
    const res = await app.request('/api/v1/w/acme/runs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_slug: 'helper', parent_slug: parent.slug }),
    });
    expect(res.status).toBe(201);
  } finally {
    env.FOLIO_AGENT_CHAINS_ENABLED = prev;
  }
  const runs = await db.query.documents.findMany({ where: eq(documents.type, 'agent_run') });
  expect(runs.length).toBe(1);
});

// ----- m55 allow-list -----

test('m55: narrowed agent bearer on disallowed parent → 403 FORBIDDEN_RESOURCE', async () => {
  const { app, db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  // Agent narrowed to a project id that is NOT seed.project.id.
  const { token } = await seedAgent(db, seed.workspace, seed.user, 'narrow', {
    projects: ['some-other-project-id'],
  });

  const prev = env.FOLIO_AGENT_CHAINS_ENABLED;
  env.FOLIO_AGENT_CHAINS_ENABLED = true; // isolate m55 from m54
  try {
    const res = await app.request('/api/v1/w/acme/runs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_slug: 'narrow', parent_slug: parent.slug }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('FORBIDDEN_RESOURCE');
  } finally {
    env.FOLIO_AGENT_CHAINS_ENABLED = prev;
  }
});

// ----- m59 ordering: a disallowed parent receives no comment -----

test('m59: 403 create (disallowed parent) posts zero comments', async () => {
  const { app, db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const { token } = await seedAgent(db, seed.workspace, seed.user, 'narrow', {
    projects: ['some-other-project-id'],
  });

  const prev = env.FOLIO_AGENT_CHAINS_ENABLED;
  env.FOLIO_AGENT_CHAINS_ENABLED = true;
  try {
    const res = await app.request('/api/v1/w/acme/runs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_slug: 'narrow', parent_slug: parent.slug, input: 'sneaky' }),
    });
    expect(res.status).toBe(403);
  } finally {
    env.FOLIO_AGENT_CHAINS_ENABLED = prev;
  }
  const comments = await listComments({ parentId: parent.id });
  expect(comments.length).toBe(0);
});

// ----- GET /runs/:runId + m58 -----

test('GET /runs/:runId returns the run (session)', async () => {
  const { app, db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const { agent } = await seedAgent(db, seed.workspace, seed.user, 'helper');
  const run = await seedRun(db, seed.workspace, seed.project, agent, seed.user, parent);

  const res = await app.request(`/api/v1/w/acme/runs/${run.id}`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const { data } = await res.json();
  expect(data.id).toBe(run.id);
  expect(data.type).toBe('agent_run');
});

test('GET /runs/:runId → 404 AGENT_RUN_NOT_FOUND for unknown id', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/runs/does-not-exist', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(404);
  expect((await res.json()).error.code).toBe('AGENT_RUN_NOT_FOUND');
});

test('m58: GET /runs/:runId for a non-run document → 404 (type re-scope)', async () => {
  const { app, db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  // parent.id is a work_item, not an agent_run.
  const res = await app.request(`/api/v1/w/acme/runs/${parent.id}`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(404);
  expect((await res.json()).error.code).toBe('AGENT_RUN_NOT_FOUND');
});

test('m58: narrowed agent bearer GET of disallowed-project run → 404', async () => {
  const { app, db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const { agent } = await seedAgent(db, seed.workspace, seed.user, 'helper');
  const run = await seedRun(db, seed.workspace, seed.project, agent, seed.user, parent);
  // A second agent narrowed away from seed.project tries to read the run.
  const { token } = await seedAgent(db, seed.workspace, seed.user, 'narrow', {
    projects: ['some-other-project-id'],
  });

  const res = await app.request(`/api/v1/w/acme/runs/${run.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(404);
  expect((await res.json()).error.code).toBe('AGENT_RUN_NOT_FOUND');
});

test('m58: GET/cancel/retry a run id from ANOTHER workspace → 404 (workspace boundary)', async () => {
  const { app, db, seed } = await makeTestApp();

  // Build a SECOND workspace + membership for the seeded user + project, then a
  // real agent_run row inside it via the production createRun path.
  const otherWsId = nanoid();
  await db.insert(workspaces).values({ id: otherWsId, slug: 'other', name: 'Other' });
  await db
    .insert(memberships)
    .values({ workspaceId: otherWsId, userId: seed.user.id, role: 'owner' });
  const otherProjectId = nanoid();
  await db
    .insert(projects)
    .values({ id: otherProjectId, workspaceId: otherWsId, slug: 'other-web', name: 'Other Web' });
  await seedProjectDefaults(db, otherProjectId);

  const [otherWorkspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, otherWsId));
  const [otherProject] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, otherProjectId));

  const otherTable = await getWorkItemsTable(db, otherProjectId);
  const otherParent = await seedWorkItem(db, otherWorkspace!, otherProject!, otherTable, seed.user);
  const { agent } = await seedAgent(db, otherWorkspace!, seed.user, 'helper');
  const otherRun = await seedRun(db, otherWorkspace!, otherProject!, agent, seed.user, otherParent);

  // Address the OTHER workspace's run via the FIRST workspace's slug ('acme').
  const get = await app.request(`/api/v1/w/acme/runs/${otherRun.id}`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(get.status).toBe(404);
  expect((await get.json()).error.code).toBe('AGENT_RUN_NOT_FOUND');

  const cancel = await app.request(`/api/v1/w/acme/runs/${otherRun.id}/cancel`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(cancel.status).toBe(404);
  expect((await cancel.json()).error.code).toBe('AGENT_RUN_NOT_FOUND');

  const retry = await app.request(`/api/v1/w/acme/runs/${otherRun.id}/retry`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(retry.status).toBe(404);
  expect((await retry.json()).error.code).toBe('AGENT_RUN_NOT_FOUND');
});

// ----- GET list (pScope) -----

test('GET project-scoped list returns the run', async () => {
  const { app, db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const { agent } = await seedAgent(db, seed.workspace, seed.user, 'helper');
  const run = await seedRun(db, seed.workspace, seed.project, agent, seed.user, parent);

  const res = await app.request('/api/v1/w/acme/p/web/runs', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const { data } = await res.json();
  expect(Array.isArray(data)).toBe(true);
  expect(data.map((r: Document) => r.id)).toContain(run.id);
});

test('GET list filters by status', async () => {
  const { app, db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const { agent } = await seedAgent(db, seed.workspace, seed.user, 'helper');
  await seedRun(db, seed.workspace, seed.project, agent, seed.user, parent);

  const res = await app.request('/api/v1/w/acme/p/web/runs?status=running', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const { data } = await res.json();
  expect(data.length).toBe(0); // the seeded run is 'planning', not 'running'
});

test('GET list → 422 INVALID_QUERY on bad since', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/p/web/runs?since=not-a-date', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('INVALID_QUERY');
});

test('GET list → 422 INVALID_QUERY on unknown status enum value', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/p/web/runs?status=garbage', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('INVALID_QUERY');
});

// ----- GET workspace-scoped list (wScope) -----

test('GET workspace-scoped list returns runs newest-first', async () => {
  const { app, db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent1 = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const parent2 = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const { agent } = await seedAgent(db, seed.workspace, seed.user, 'helper');
  const run1 = await seedRun(db, seed.workspace, seed.project, agent, seed.user, parent1);
  const run2 = await seedRun(db, seed.workspace, seed.project, agent, seed.user, parent2);
  // The two seeds can land in the same millisecond; pin run1 strictly older so
  // the desc(createdAt) ordering assertion tests real ordering, not tie-luck.
  await db
    .update(documents)
    .set({ createdAt: new Date(Date.now() - 60_000) })
    .where(eq(documents.id, run1.id));

  const res = await app.request('/api/v1/w/acme/runs', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const { data } = await res.json();
  expect(Array.isArray(data)).toBe(true);
  const ids = data.map((r: Document) => r.id);
  expect(ids).toContain(run1.id);
  expect(ids).toContain(run2.id);
  // newest-first (desc createdAt) — run2 created after run1
  expect(ids.indexOf(run2.id)).toBeLessThan(ids.indexOf(run1.id));
});

test('GET workspace-scoped list honors ?limit=', async () => {
  const { app, db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent1 = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const parent2 = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const { agent } = await seedAgent(db, seed.workspace, seed.user, 'helper');
  await seedRun(db, seed.workspace, seed.project, agent, seed.user, parent1);
  await seedRun(db, seed.workspace, seed.project, agent, seed.user, parent2);

  const res = await app.request('/api/v1/w/acme/runs?limit=1', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const { data } = await res.json();
  expect(data.length).toBe(1);
});

test('GET workspace-scoped list → 422 INVALID_QUERY on unknown status enum value', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/runs?status=garbage', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('INVALID_QUERY');
});

// ----- POST /runs/:runId/cancel -----

test('cancel a planning run → failed', async () => {
  const { app, db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const { agent } = await seedAgent(db, seed.workspace, seed.user, 'helper');
  const run = await seedRun(db, seed.workspace, seed.project, agent, seed.user, parent);

  const res = await app.request(`/api/v1/w/acme/runs/${run.id}/cancel`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const { data } = await res.json();
  expect(data.status).toBe('failed');

  const row = await db.query.documents.findFirst({ where: eq(documents.id, run.id) });
  expect(row?.status).toBe('failed');
  expect((row?.frontmatter as { error_reason?: string }).error_reason).toBe('cancelled');
});

test('cancel a running run posts a rejection comment + stays running (m44)', async () => {
  const { app, db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const { agent } = await seedAgent(db, seed.workspace, seed.user, 'helper');
  const run = await seedRun(db, seed.workspace, seed.project, agent, seed.user, parent);
  // Drive it to running directly.
  await db
    .update(documents)
    .set({
      status: 'running',
      frontmatter: { ...(run.frontmatter as Record<string, unknown>), status: 'running' },
    })
    .where(eq(documents.id, run.id));

  const res = await app.request(`/api/v1/w/acme/runs/${run.id}/cancel`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const { data } = await res.json();
  expect(data.status).toBe('running');

  const rejections = await listComments({ parentId: parent.id, kind: 'rejection' });
  expect(rejections.length).toBe(1);
});

test('cancel a terminal run is a no-op returning current status', async () => {
  const { app, db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const { agent } = await seedAgent(db, seed.workspace, seed.user, 'helper');
  const run = await seedRun(db, seed.workspace, seed.project, agent, seed.user, parent);
  await db
    .update(documents)
    .set({
      status: 'failed',
      frontmatter: { ...(run.frontmatter as Record<string, unknown>), status: 'failed' },
    })
    .where(eq(documents.id, run.id));

  const res = await app.request(`/api/v1/w/acme/runs/${run.id}/cancel`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  expect((await res.json()).data.status).toBe('failed');
});

// ----- POST /runs/:runId/retry -----

test('retry a terminal run creates a fresh planning run → 201 (m63 happy)', async () => {
  const { app, db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const { agent } = await seedAgent(db, seed.workspace, seed.user, 'helper');
  const run = await seedRun(db, seed.workspace, seed.project, agent, seed.user, parent);
  // Terminalize the original so it's not an active peer.
  await db
    .update(documents)
    .set({
      status: 'failed',
      frontmatter: { ...(run.frontmatter as Record<string, unknown>), status: 'failed' },
    })
    .where(eq(documents.id, run.id));

  const res = await app.request(`/api/v1/w/acme/runs/${run.id}/retry`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(201);
  const { data } = await res.json();
  expect(data.status).toBe('planning');
  expect(data.run_id).not.toBe(run.id);

  const runs = await db.query.documents.findMany({ where: eq(documents.type, 'agent_run') });
  expect(runs.length).toBe(2);
});

test('retry while original still active → 409 RUN_ALREADY_ACTIVE (m63)', async () => {
  const { app, db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const { agent } = await seedAgent(db, seed.workspace, seed.user, 'helper');
  const run = await seedRun(db, seed.workspace, seed.project, agent, seed.user, parent);

  const res = await app.request(`/api/v1/w/acme/runs/${run.id}/retry`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(409);
  expect((await res.json()).error.code).toBe('RUN_ALREADY_ACTIVE');
});

// ----- Finding 2: retry path must honor the autonomy gate (m54) -----

test('Finding 2: agent-bound bearer retry with chains OFF → 403 + suppressed + no new run', async () => {
  const { app, db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const { agent, token } = await seedAgent(db, seed.workspace, seed.user, 'helper');
  const run = await seedRun(db, seed.workspace, seed.project, agent, seed.user, parent);
  // Terminalize the original so idempotency would NOT block it — the gate must.
  await db
    .update(documents)
    .set({
      status: 'failed',
      frontmatter: { ...(run.frontmatter as Record<string, unknown>), status: 'failed' },
    })
    .where(eq(documents.id, run.id));

  const seen: string[] = [];
  const unsub = eventBus.subscribe(seed.workspace.id, undefined, (e) => {
    if (e.kind === 'agent.chain.suppressed') seen.push(e.kind);
  });

  const prev = env.FOLIO_AGENT_CHAINS_ENABLED;
  env.FOLIO_AGENT_CHAINS_ENABLED = false;
  try {
    const res = await app.request(`/api/v1/w/acme/runs/${run.id}/retry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('AGENT_CHAINS_DISABLED');
  } finally {
    env.FOLIO_AGENT_CHAINS_ENABLED = prev;
    unsub();
  }

  // Only the seeded (failed) original — no fresh planning run.
  const runs = await db.query.documents.findMany({ where: eq(documents.type, 'agent_run') });
  expect(runs.length).toBe(1);
  expect(seen).toEqual(['agent.chain.suppressed']);
});

test('Finding 2: agent-bound bearer retry with chains ON → 201 (gate only blocks when off)', async () => {
  const { app, db, seed } = await makeTestApp();
  const table = await getWorkItemsTable(db, seed.project.id);
  const parent = await seedWorkItem(db, seed.workspace, seed.project, table, seed.user);
  const { agent, token } = await seedAgent(db, seed.workspace, seed.user, 'helper');
  const run = await seedRun(db, seed.workspace, seed.project, agent, seed.user, parent);
  await db
    .update(documents)
    .set({
      status: 'failed',
      frontmatter: { ...(run.frontmatter as Record<string, unknown>), status: 'failed' },
    })
    .where(eq(documents.id, run.id));

  const prev = env.FOLIO_AGENT_CHAINS_ENABLED;
  env.FOLIO_AGENT_CHAINS_ENABLED = true;
  try {
    const res = await app.request(`/api/v1/w/acme/runs/${run.id}/retry`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(201);
    expect((await res.json()).data.status).toBe('planning');
  } finally {
    env.FOLIO_AGENT_CHAINS_ENABLED = prev;
  }
  const runs = await db.query.documents.findMany({ where: eq(documents.type, 'agent_run') });
  expect(runs.length).toBe(2);
});
