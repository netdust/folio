import { test, expect } from 'bun:test';
import { nanoid } from 'nanoid';
import { makeTestApp } from '../test/harness.ts';
import { projects, events } from '../db/schema.ts';
import { eq } from 'drizzle-orm';

const WS_PATH = '/api/v1/w/acme/documents';

async function postWorkspaceDoc(
  app: Awaited<ReturnType<typeof makeTestApp>>['app'],
  cookie: string,
  body: Record<string, unknown>,
) {
  return app.request(WS_PATH, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('POST /api/v1/w/:wslug/documents creates an agent with workspace_id and project_id NULL', async () => {
  const { app, seed } = await makeTestApp();
  const res = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent',
    title: 'Triage Bot',
    frontmatter: {
      system_prompt: 'Triage incoming work.',
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      tools: ['list_documents'],
    },
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.data.type).toBe('agent');
  expect(body.data.workspaceId).toBe(seed.workspace.id);
  expect(body.data.projectId ?? null).toBeNull();
  // Default applied by the Zod schema.
  expect(body.data.frontmatter.projects).toEqual(['*']);
});

test('POST rejects non-agent, non-trigger types', async () => {
  const { app, seed } = await makeTestApp();
  const res = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'work_item',
    title: 'No work items at workspace level',
  });
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('INVALID_DOCUMENT_SCOPE');
});

test('POST agent with explicit projects list persists the array', async () => {
  const { app, db, seed } = await makeTestApp();
  // Add a second project so the array references real ids.
  const projectBId = nanoid();
  await db.insert(projects).values({
    id: projectBId,
    workspaceId: seed.workspace.id,
    slug: 'inbox',
    name: 'Inbox',
  });

  const res = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent',
    title: 'Inbox Triager',
    frontmatter: {
      system_prompt: 'Only Inbox.',
      model: 'm',
      provider: 'anthropic',
      tools: [],
      projects: [projectBId],
    },
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.data.frontmatter.projects).toEqual([projectBId]);
});

test('POST agent with wildcard mixed in explicit list is 422', async () => {
  const { app, seed } = await makeTestApp();
  const res = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent',
    title: 'Bad',
    frontmatter: {
      system_prompt: 'x',
      model: 'm',
      provider: 'anthropic',
      tools: [],
      projects: ['*', 'whatever'],
    },
  });
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('INVALID_AGENT_FRONTMATTER');
});

test('GET ?type=agent returns workspace agents', async () => {
  const { app, seed } = await makeTestApp();
  await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'A',
    frontmatter: { system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [] },
  });
  await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'B',
    frontmatter: { system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [] },
  });
  const res = await app.request(`${WS_PATH}?type=agent`, { headers: { Cookie: seed.sessionCookie } });
  const body = await res.json();
  expect(body.data).toHaveLength(2);
});

test('GET ?type=agent&project=:pid filters by allow-list membership', async () => {
  const { app, db, seed } = await makeTestApp();
  const projectBId = nanoid();
  await db.insert(projects).values({
    id: projectBId,
    workspaceId: seed.workspace.id,
    slug: 'inbox',
    name: 'Inbox',
  });

  // Two agents: one project-A-only, one wildcard.
  await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'A-only',
    frontmatter: {
      system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [],
      projects: [seed.project.id],
    },
  });
  await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'Wildcard',
    frontmatter: {
      system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [],
      projects: ['*'],
    },
  });

  // Filter to project B: only the wildcard agent matches.
  const res = await app.request(`${WS_PATH}?type=agent&project=${projectBId}`, {
    headers: { Cookie: seed.sessionCookie },
  });
  const body = await res.json();
  const titles = body.data.map((d: { title: string }) => d.title);
  expect(titles).toEqual(['Wildcard']);
});

test('PATCH updates agent frontmatter.projects', async () => {
  const { app, db, seed } = await makeTestApp();
  const projectBId = nanoid();
  await db.insert(projects).values({
    id: projectBId,
    workspaceId: seed.workspace.id,
    slug: 'inbox',
    name: 'Inbox',
  });

  const createRes = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'A',
    frontmatter: {
      system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [],
      projects: [seed.project.id],
    },
  });
  const created = (await createRes.json()).data;

  // PATCH only the changed field — sending the full frontmatter back would
  // include server-managed `api_token_id` which the .strict() schema rejects.
  const patchRes = await app.request(`${WS_PATH}/${created.slug}`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      frontmatter: { projects: [seed.project.id, projectBId] },
    }),
  });
  expect(patchRes.status).toBe(200);
  const updated = (await patchRes.json()).data;
  expect(updated.frontmatter.projects).toEqual([seed.project.id, projectBId]);
});

test('DELETE removes the agent + cascades the token', async () => {
  const { app, db, seed } = await makeTestApp();
  const create = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'Goner',
    frontmatter: { system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [] },
  });
  const created = (await create.json()).data;

  const del = await app.request(`${WS_PATH}/${created.slug}`, {
    method: 'DELETE',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(del.status).toBe(204);

  const { apiTokens, documents } = await import('../db/schema.ts');
  const { eq } = await import('drizzle-orm');
  const remainingDoc = await db.query.documents.findFirst({ where: eq(documents.id, created.id) });
  expect(remainingDoc).toBeUndefined();
  const remainingTokens = await db.query.apiTokens.findMany({
    where: eq(apiTokens.agentId, created.id),
  });
  expect(remainingTokens).toHaveLength(0);
});

test('two agents in the same workspace can share a base slug only after disambiguation', async () => {
  const { app, seed } = await makeTestApp();
  const first = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'Bot',
    frontmatter: { system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [] },
  });
  const second = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'Bot',
    frontmatter: { system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [] },
  });
  expect((await first.json()).data.slug).toBe('bot');
  expect((await second.json()).data.slug).toBe('bot-2');
});

// ---------------------------------------------------------------------------
// POST /:slug/activity — workspace-level activity endpoint (Phase 2.6 A7)
// ---------------------------------------------------------------------------

async function createAgent(
  app: Awaited<ReturnType<typeof makeTestApp>>['app'],
  cookie: string,
  title = 'Activity Bot',
) {
  const res = await postWorkspaceDoc(app, cookie, {
    type: 'agent',
    title,
    frontmatter: { system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [] },
  });
  return (await res.json()).data as { id: string; slug: string };
}

test('POST /:slug/activity — 201 happy path on agent', async () => {
  const { app, db, seed } = await makeTestApp();
  const agent = await createAgent(app, seed.sessionCookie);

  const res = await app.request(`${WS_PATH}/${agent.slug}/activity`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'Agent ran successfully' }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  // Response shape.
  expect(body.data.lastTouchedAt).toBeString();
  expect(() => new Date(body.data.lastTouchedAt)).not.toThrow();

  // Agent row bumped.
  const { documents } = await import('../db/schema.ts');
  const row = await db.query.documents.findFirst({ where: eq(documents.id, agent.id) });
  expect(row?.lastTouchedAt).not.toBeNull();

  // activity.logged event inserted with projectId null.
  const { and } = await import('drizzle-orm');
  const eventRow = await db.query.events.findFirst({
    where: and(eq(events.documentId, agent.id), eq(events.kind, 'activity.logged')),
  });
  expect(eventRow?.kind).toBe('activity.logged');
  expect(eventRow?.projectId).toBeNull();
  expect((eventRow?.payload as { note: string }).note).toBe('Agent ran successfully');
});

test('POST /:slug/activity — 404 when agent slug does not exist', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(`${WS_PATH}/nonexistent-slug/activity`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'Hello' }),
  });
  expect(res.status).toBe(404);
  const body = await res.json();
  expect(body.error.code).toBe('DOCUMENT_NOT_FOUND');
});

test('POST /:slug/activity — 422 INVALID_NOTE when note is empty', async () => {
  const { app, seed } = await makeTestApp();
  const agent = await createAgent(app, seed.sessionCookie);

  const res = await app.request(`${WS_PATH}/${agent.slug}/activity`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: '   ' }),
  });
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('INVALID_NOTE');
});

test('POST /:slug/activity — 422 NOTE_TOO_LONG when note exceeds 2000 chars', async () => {
  const { app, seed } = await makeTestApp();
  const agent = await createAgent(app, seed.sessionCookie);

  const res = await app.request(`${WS_PATH}/${agent.slug}/activity`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'a'.repeat(2001) }),
  });
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('NOTE_TOO_LONG');
});

test('POST /:slug/activity — 201 at exactly 2000 chars (boundary)', async () => {
  const { app, seed } = await makeTestApp();
  const agent = await createAgent(app, seed.sessionCookie);

  const res = await app.request(`${WS_PATH}/${agent.slug}/activity`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'b'.repeat(2000) }),
  });
  expect(res.status).toBe(201);
});

test('POST /:slug/activity — 422 INVALID_ACTIVITY_TARGET when doc is a trigger', async () => {
  const { app, seed } = await makeTestApp();
  // Create a trigger doc at workspace level (must satisfy triggerFrontmatterSchema).
  const triggerRes = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'trigger',
    title: 'Webhook Trigger',
    frontmatter: {
      agent: 'some-agent',
      schedule: '* * * * *',
      on_event: null,
    },
  });
  const trigger = (await triggerRes.json()).data as { slug: string };

  const res = await app.request(`${WS_PATH}/${trigger.slug}/activity`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'Should be rejected' }),
  });
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('INVALID_ACTIVITY_TARGET');
});

// ---------------------------------------------------------------------------
// GET /:slug/events — workspace-level events read (Phase 2.6 C10)
// ---------------------------------------------------------------------------

test('GET /:slug/events — happy path returns events for an agent', async () => {
  const { app, seed } = await makeTestApp();
  const agent = await createAgent(app, seed.sessionCookie);
  // Generate two events via the activity endpoint.
  await app.request(`${WS_PATH}/${agent.slug}/activity`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'first' }),
  });
  await app.request(`${WS_PATH}/${agent.slug}/activity`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'second' }),
  });

  const res = await app.request(`${WS_PATH}/${agent.slug}/events`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  // Activity events + the agent.created event from the create flow.
  expect(body.data.length).toBeGreaterThanOrEqual(2);

  // Public shape only — internal columns must not leak (matches the
  // project-scoped handler's contract).
  for (const e of body.data) {
    expect(Object.keys(e).sort()).toEqual(['actor', 'createdAt', 'id', 'kind', 'payload'].sort());
    expect(e.workspaceId).toBeUndefined();
    expect(e.projectId).toBeUndefined();
    expect(e.documentId).toBeUndefined();
  }
});

test('GET /:slug/events — works on a trigger doc (empty if no events yet)', async () => {
  const { app, seed } = await makeTestApp();
  const triggerRes = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'trigger',
    title: 'My Trigger',
    frontmatter: { agent: 'x', schedule: '* * * * *', on_event: null },
  });
  const trigger = (await triggerRes.json()).data as { slug: string };

  const res = await app.request(`${WS_PATH}/${trigger.slug}/events`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  // Trigger create may emit document.created — endpoint just shouldn't 404 or
  // 422. We assert it returns an array regardless of contents.
  expect(Array.isArray(body.data)).toBe(true);
});

test('GET /:slug/events — 404 when slug does not exist', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(`${WS_PATH}/nope/events`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(404);
  const body = await res.json();
  expect(body.error.code).toBe('DOCUMENT_NOT_FOUND');
});

test('GET /:slug/events — newest-first ordering', async () => {
  const { app, seed } = await makeTestApp();
  const agent = await createAgent(app, seed.sessionCookie);
  await app.request(`${WS_PATH}/${agent.slug}/activity`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'first-note' }),
  });
  await app.request(`${WS_PATH}/${agent.slug}/activity`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'second-note' }),
  });

  const res = await app.request(`${WS_PATH}/${agent.slug}/events`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  const activityRows = body.data.filter(
    (e: { kind: string }) => e.kind === 'activity.logged',
  ) as { payload: { note: string } }[];
  expect(activityRows).toHaveLength(2);
  // Newest first → second-note comes before first-note.
  expect(activityRows[0]?.payload.note).toBe('second-note');
  expect(activityRows[1]?.payload.note).toBe('first-note');
});

test('GET /:slug/events — 422 INVALID_LIMIT when limit is 0', async () => {
  const { app, seed } = await makeTestApp();
  const agent = await createAgent(app, seed.sessionCookie);
  const res = await app.request(`${WS_PATH}/${agent.slug}/events?limit=0`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('INVALID_LIMIT');
});

test('GET /:slug/events — 422 INVALID_LIMIT when limit is negative', async () => {
  const { app, seed } = await makeTestApp();
  const agent = await createAgent(app, seed.sessionCookie);
  const res = await app.request(`${WS_PATH}/${agent.slug}/events?limit=-3`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('INVALID_LIMIT');
});

test('GET /:slug/events — 422 INVALID_LIMIT when limit is non-integer', async () => {
  const { app, seed } = await makeTestApp();
  const agent = await createAgent(app, seed.sessionCookie);
  const res = await app.request(`${WS_PATH}/${agent.slug}/events?limit=abc`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(422);
  expect((await res.json()).error.code).toBe('INVALID_LIMIT');
});

// ---------------------------------------------------------------------------
// F1 — agents:write scope + widening + self-delete guards (Phase 2.6 review)
//
// Before the fix, the HTTP path enforced only documents:write/documents:delete,
// so any PAT with documents:write could mint, widen, or delete an agent —
// bypassing the agents:write scope and the allow-list widening + self-delete
// guards that mcp.ts already enforces.
// ---------------------------------------------------------------------------

import { newApiToken } from '../lib/auth.ts';
import { apiTokens, documents as documentsTable } from '../db/schema.ts';
import { db as realDb } from '../db/client.ts';

async function mintPAT(workspaceId: string, userId: string, scopes: string[]): Promise<string> {
  const { token, hash } = newApiToken();
  await realDb.insert(apiTokens).values({
    id: nanoid(),
    workspaceId,
    name: 'test-pat',
    tokenHash: hash,
    scopes,
    createdBy: userId,
  });
  return token;
}

test('F1: POST type=agent rejects PAT with documents:write but no agents:write', async () => {
  const { app, seed } = await makeTestApp();
  const pat = await mintPAT(seed.workspace.id, seed.user.id, ['documents:write', 'documents:read']);

  const res = await app.request(WS_PATH, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'agent',
      title: 'Sneaky',
      frontmatter: { system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [] },
    }),
  });
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('FORBIDDEN_SCOPE');
});

test('F1: POST type=trigger still works with documents:write alone (agents:write only gates agents)', async () => {
  const { app, seed } = await makeTestApp();
  const pat = await mintPAT(seed.workspace.id, seed.user.id, ['documents:write', 'documents:read']);

  const res = await app.request(WS_PATH, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'trigger',
      title: 'Daily',
      frontmatter: { agent: 'x', schedule: '0 9 * * *', on_event: null },
    }),
  });
  expect(res.status).toBe(201);
});

test('F1: POST type=agent allowed for PAT carrying agents:write', async () => {
  const { app, seed } = await makeTestApp();
  const pat = await mintPAT(seed.workspace.id, seed.user.id, [
    'documents:write', 'documents:read', 'agents:write',
  ]);

  const res = await app.request(WS_PATH, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'agent',
      title: 'Allowed',
      frontmatter: { system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [] },
    }),
  });
  expect(res.status).toBe(201);
});

test('F1: PATCH type=agent rejects PAT with documents:write but no agents:write', async () => {
  const { app, seed } = await makeTestApp();
  const agent = await createAgent(app, seed.sessionCookie);
  const pat = await mintPAT(seed.workspace.id, seed.user.id, ['documents:write', 'documents:read']);

  const res = await app.request(`${WS_PATH}/${agent.slug}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Renamed' }),
  });
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('FORBIDDEN_SCOPE');
});

test('F1: DELETE type=agent rejects PAT with documents:delete but no agents:write', async () => {
  const { app, seed } = await makeTestApp();
  const agent = await createAgent(app, seed.sessionCookie);
  const pat = await mintPAT(seed.workspace.id, seed.user.id, ['documents:delete', 'documents:read']);

  const res = await app.request(`${WS_PATH}/${agent.slug}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${pat}` },
  });
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('FORBIDDEN_SCOPE');
});

test('F1: POST blocks an agent-bound caller from minting a child with wider projects', async () => {
  const { app, seed } = await makeTestApp();
  // Create the calling agent with a narrow allow-list. Seeded project id is `seed.project.id`.
  const parentRes = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'Parent',
    frontmatter: {
      system_prompt: 'x', model: 'm', provider: 'anthropic', tools: ['create_agent'],
      projects: [seed.project.id],
    },
  });
  expect(parentRes.status).toBe(201);
  const parent = (await parentRes.json()).data as { id: string };

  // Mint a token bound to that agent, carrying agents:write.
  const { token, hash } = newApiToken();
  await realDb.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    name: 'parent-bound',
    tokenHash: hash,
    scopes: ['agents:write', 'documents:write', 'documents:read'],
    createdBy: seed.user.id,
    agentId: parent.id,
  });

  const res = await app.request(WS_PATH, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'agent',
      title: 'Wider Child',
      frontmatter: {
        system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [],
        projects: ['*'],
      },
    }),
  });
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('ALLOW_LIST_WIDENING_FORBIDDEN');
});

test('F1: PATCH blocks an agent-bound caller from widening a target agent past its own list', async () => {
  const { app, seed } = await makeTestApp();
  const parentRes = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'Parent',
    frontmatter: {
      system_prompt: 'x', model: 'm', provider: 'anthropic', tools: ['update_agent'],
      projects: [seed.project.id],
    },
  });
  const parent = (await parentRes.json()).data as { id: string };
  const targetRes = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'Target',
    frontmatter: {
      system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [],
      projects: [seed.project.id],
    },
  });
  const target = (await targetRes.json()).data as { slug: string };

  const { token, hash } = newApiToken();
  await realDb.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    name: 'parent-bound',
    tokenHash: hash,
    scopes: ['agents:write', 'documents:write', 'documents:read'],
    createdBy: seed.user.id,
    agentId: parent.id,
  });

  const res = await app.request(`${WS_PATH}/${target.slug}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ frontmatter: { projects: ['*'] } }),
  });
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('ALLOW_LIST_WIDENING_FORBIDDEN');
});

test('F1: DELETE blocks an agent-bound caller from deleting itself', async () => {
  const { app, seed } = await makeTestApp();
  const selfRes = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'Self',
    frontmatter: { system_prompt: 'x', model: 'm', provider: 'anthropic', tools: ['delete_agent'] },
  });
  const self = (await selfRes.json()).data as { id: string; slug: string };

  const { token, hash } = newApiToken();
  await realDb.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    name: 'self-bound',
    tokenHash: hash,
    scopes: ['agents:write', 'documents:delete', 'documents:read'],
    createdBy: seed.user.id,
    agentId: self.id,
  });

  const res = await app.request(`${WS_PATH}/${self.slug}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('CANNOT_DELETE_SELF');
});
