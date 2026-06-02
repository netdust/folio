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

// BUG-019 — bare `await c.req.json()` threw an unwrapped SyntaxError
// on empty/malformed bodies, surfacing as 500. The documented contract
// is 422 INVALID_BODY. Wrap in try/catch + HTTPError. Agents retrying
// on 5xx but treating 4xx as terminal would otherwise loop forever.
test('BUG-019: POST with empty body returns 422 INVALID_BODY (not 500)', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(WS_PATH, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: '',
  });
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('INVALID_BODY');
});

test('BUG-019: POST with malformed JSON returns 422 INVALID_BODY (not 500)', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request(WS_PATH, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: '{title:',
  });
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('INVALID_BODY');
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

// BUG-018 — `listWorkspaceDocuments` parsed `frontmatter.projects` directly
// via Array.isArray + includes. Legacy / hand-imported / pre-2.5 agents
// with missing or non-array `projects` fell through to `false` in the
// filter — operators saw "agent doesn't show up in this project's
// assignee dropdown" even though bearer/SSE/mention-parser (which all
// route through resolveAgentProjects) granted access. Fix: route the
// filter through resolveAgentProjects so the missing/non-array fallback
// to ['*'] is honoured consistently.
test('BUG-018: agent with no frontmatter.projects defaults to wildcard (visible in any project)', async () => {
  const { app, db, seed } = await makeTestApp();
  const { documents } = await import('../db/schema.ts');
  const { nanoid: nano } = await import('nanoid');

  // Insert an agent the legacy way — no `projects` field at all. This
  // simulates a pre-2.5 row or a hand-edited markdown import.
  const legacyId = nano();
  await db.insert(documents).values({
    id: legacyId,
    workspaceId: seed.workspace.id,
    projectId: null,
    tableId: null,
    type: 'agent',
    slug: 'legacy-agent',
    title: 'Legacy Agent',
    body: '',
    frontmatter: {
      // NB: no `projects` key. resolveAgentProjects fallback should treat as ['*'].
      system_prompt: 'help',
      model: 'm',
      provider: 'anthropic',
      tools: [],
    },
    createdBy: seed.user.id,
    updatedBy: seed.user.id,
  });

  // Make a second project to filter by.
  const projectBId = nanoid();
  await db.insert(projects).values({
    id: projectBId,
    workspaceId: seed.workspace.id,
    slug: 'inbox',
    name: 'Inbox',
  });

  // Filter to project B: the legacy agent SHOULD appear (no projects = wildcard).
  const res = await app.request(`${WS_PATH}?type=agent&project=${projectBId}`, {
    headers: { Cookie: seed.sessionCookie },
  });
  const body = await res.json();
  const titles: string[] = body.data.map((d: { title: string }) => d.title);
  expect(titles).toContain('Legacy Agent');
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
  // Round 7 #19 — the human-PAT rejection now fires BEFORE the scope check,
  // so any human PAT (regardless of agents:write presence) hits
  // HUMAN_PAT_AGENT_LIFECYCLE_HTTP first. The pre-round-7 FORBIDDEN_SCOPE
  // path for human PATs is unreachable now; what this test demonstrates
  // is that the new gate is strictly stronger (rejects everything the old
  // gate rejected, AND more).
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
  expect((await res.json()).error.code).toBe('HUMAN_PAT_AGENT_LIFECYCLE_HTTP');
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

test('F1 (round-7 #19 revision): PAT carrying agents:write is REJECTED for type=agent (was allowed pre-round-7)', async () => {
  // Pre-round-7 this test asserted 201 — a human PAT with agents:write
  // could mint an agent. Threat-model attack 18 identified that as a
  // credential-escalation vector (stolen PAT mints arbitrary-scope agents).
  // Round 7 #19 rejects human PATs uniformly on agent CRUD; agents:write
  // alone is no longer sufficient. The test stays as a regression marker
  // — flipping it back to 201 means the round 7 gate was undone.
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
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('HUMAN_PAT_AGENT_LIFECYCLE_HTTP');
});

test('F1: PATCH type=agent rejects PAT with documents:write but no agents:write', async () => {
  // Round 7 #19 — human-PAT rejection fires before scope check; the error
  // code is now HUMAN_PAT_AGENT_LIFECYCLE_HTTP instead of FORBIDDEN_SCOPE.
  // The new gate is strictly stronger.
  const { app, seed } = await makeTestApp();
  const agent = await createAgent(app, seed.sessionCookie);
  const pat = await mintPAT(seed.workspace.id, seed.user.id, ['documents:write', 'documents:read']);

  const res = await app.request(`${WS_PATH}/${agent.slug}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Renamed' }),
  });
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('HUMAN_PAT_AGENT_LIFECYCLE_HTTP');
});

test('F1: DELETE type=agent rejects PAT with documents:delete but no agents:write', async () => {
  // Round 7 #19 — human-PAT rejection fires before scope check.
  const { app, seed } = await makeTestApp();
  const agent = await createAgent(app, seed.sessionCookie);
  const pat = await mintPAT(seed.workspace.id, seed.user.id, ['documents:delete', 'documents:read']);

  const res = await app.request(`${WS_PATH}/${agent.slug}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${pat}` },
  });
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('HUMAN_PAT_AGENT_LIFECYCLE_HTTP');
});

test('G4: POST blocks an agent-bound caller from minting a child by OMITTING the projects key (Zod default bypass)', async () => {
  const { app, seed } = await makeTestApp();
  // Calling agent restricted to seed.project.id.
  const parentRes = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'Parent',
    frontmatter: {
      system_prompt: 'x', model: 'm', provider: 'anthropic', tools: ['create_agent'],
      projects: [seed.project.id],
    },
  });
  const parent = (await parentRes.json()).data as { id: string };
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

  // OMIT the projects key — pre-G4 the guard short-circuited and Zod's
  // .default(['*']) widened the child to workspace-wide.
  const res = await app.request(WS_PATH, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'agent',
      title: 'Child No Projects Key',
      frontmatter: { system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [] },
    }),
  });
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('ALLOW_LIST_WIDENING_FORBIDDEN');
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

// BUG-005 (shake-out): tools-widening / scope escalation
//
// An agent-bound token with a narrow toolset must not be able to create or
// patch a child agent with tools the caller doesn't have — otherwise the child
// token (whose scopes are derived from tools via toolsToScopes) inherits powers
// the caller never had. This is a one-call instance-wide privilege escalation
// before the fix.

test('BUG-005: POST blocks an agent-bound caller from minting a child with wider tools', async () => {
  const { app, seed } = await makeTestApp();
  // Caller has only read-only tools.
  const parentRes = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'Read-only Parent',
    frontmatter: {
      system_prompt: 'x', model: 'm', provider: 'anthropic',
      tools: ['create_agent', 'list_documents'],
      projects: ['*'],
    },
  });
  const parent = (await parentRes.json()).data as { id: string };
  const { token, hash } = newApiToken();
  await realDb.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    name: 'narrow-bound',
    tokenHash: hash,
    scopes: ['agents:write', 'documents:write', 'documents:read'],
    createdBy: seed.user.id,
    agentId: parent.id,
  });

  // Child wants delete_document — caller doesn't have it.
  const res = await app.request(WS_PATH, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'agent',
      title: 'Escalating Child',
      frontmatter: {
        system_prompt: 'x', model: 'm', provider: 'anthropic',
        tools: ['delete_document', 'create_agent'],
        projects: ['*'],
      },
    }),
  });
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('TOOLS_WIDENING_FORBIDDEN');
});

test('BUG-005: POST allows a child whose tools are a subset of the calling agent', async () => {
  const { app, seed } = await makeTestApp();
  const parentRes = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'Parent',
    frontmatter: {
      system_prompt: 'x', model: 'm', provider: 'anthropic',
      tools: ['create_agent', 'list_documents', 'get_document'],
      projects: ['*'],
    },
  });
  const parent = (await parentRes.json()).data as { id: string };
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
      title: 'Subset Child',
      frontmatter: {
        system_prompt: 'x', model: 'm', provider: 'anthropic',
        tools: ['list_documents'],
        projects: ['*'],
      },
    }),
  });
  expect(res.status).toBe(201);
});

test('BUG-005: PATCH blocks an agent-bound caller from widening a target agent past its own tools', async () => {
  const { app, seed } = await makeTestApp();
  const parentRes = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'Parent',
    frontmatter: {
      system_prompt: 'x', model: 'm', provider: 'anthropic',
      tools: ['update_agent', 'list_documents'],
      projects: ['*'],
    },
  });
  const parent = (await parentRes.json()).data as { id: string };
  const targetRes = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'Target',
    frontmatter: {
      system_prompt: 'x', model: 'm', provider: 'anthropic',
      tools: ['list_documents'],
      projects: ['*'],
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
    body: JSON.stringify({ frontmatter: { tools: ['delete_document'] } }),
  });
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('TOOLS_WIDENING_FORBIDDEN');
});

test('BUG-005 (round-7 #19 revision): human PATs no longer mint agents via HTTP at all', async () => {
  // Pre-round-7 this test asserted that human PATs with agents:write could
  // mint agents (and that the tools-widening guard correctly bypassed for
  // them since it's an agent-bound-only check). Round 7 #19 closes the
  // outer door: human PATs cannot create agents on HTTP at all. The
  // tools-widening invariant for agent-bound bearers remains tested by the
  // F1/G4 tests above; this one becomes a regression marker for the round-7
  // outer gate.
  const { app, seed } = await makeTestApp();
  const pat = await mintPAT(seed.workspace.id, seed.user.id, [
    'agents:write', 'documents:write', 'documents:read',
  ]);
  const res = await app.request(WS_PATH, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'agent',
      title: 'Human-minted',
      frontmatter: {
        system_prompt: 'x', model: 'm', provider: 'anthropic',
        tools: ['delete_document', 'create_agent'],
        projects: ['*'],
      },
    }),
  });
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('HUMAN_PAT_AGENT_LIFECYCLE_HTTP');
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

// ---------------------------------------------------------------------------
// Round 7 #19 — HTTP agent-lifecycle rejects human PATs.
//
// Threat model attack 18 + mitigation 19. Round 6 #1 closed the same gap on
// MCP; this round closes the HTTP twin. A stolen human PAT carrying
// agents:write must NOT be able to mint, patch, or delete an agent_token
// credential via the HTTP surface either. Agent-bound bearers (legitimate
// self-management) and session callers (admin workflow) continue to work.
// ---------------------------------------------------------------------------

test('Round 7 #19: POST /documents type=agent rejects human PAT with 403', async () => {
  const { app, seed } = await makeTestApp();
  const pat = await mintPAT(seed.workspace.id, seed.user.id, [
    'documents:write', 'documents:read', 'agents:write',
  ]);

  const res = await app.request(WS_PATH, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'agent',
      title: 'PWN',
      frontmatter: { system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [] },
    }),
  });
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('HUMAN_PAT_AGENT_LIFECYCLE_HTTP');
});

test('Round 7 #19: POST /documents type=agent accepts session callers (admin workflow)', async () => {
  const { app, seed } = await makeTestApp();
  const res = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent',
    title: 'Admin Created',
    frontmatter: { system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [] },
  });
  expect(res.status).toBe(201);
});

test('Round 7 #19: POST /documents type=agent accepts agent-bound bearers (self-management)', async () => {
  const { app, seed } = await makeTestApp();
  // Mint a parent agent via session so we have something to bind a token to.
  const parentRes = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'Parent',
    frontmatter: {
      system_prompt: 'p', model: 'm', provider: 'anthropic',
      tools: ['create_agent'], projects: ['*'],
    },
  });
  expect(parentRes.status).toBe(201);
  const parent = (await parentRes.json()).data as { id: string };

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
      title: 'Child',
      frontmatter: {
        system_prompt: 'c', model: 'm', provider: 'anthropic',
        tools: [], projects: ['*'],
      },
    }),
  });
  expect(res.status).toBe(201);
});

test('Round 7 #19: POST /documents type=trigger still works for human PATs (carve-out is type=agent only)', async () => {
  const { app, seed } = await makeTestApp();
  const pat = await mintPAT(seed.workspace.id, seed.user.id, [
    'documents:write', 'documents:read',
  ]);

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

test('Round 7 #19: PATCH agent rejects human PAT with 403', async () => {
  const { app, seed } = await makeTestApp();
  const agent = await createAgent(app, seed.sessionCookie);
  const pat = await mintPAT(seed.workspace.id, seed.user.id, [
    'documents:write', 'documents:read', 'agents:write',
  ]);

  const res = await app.request(`${WS_PATH}/${agent.slug}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Renamed' }),
  });
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('HUMAN_PAT_AGENT_LIFECYCLE_HTTP');
});

test('Round 7 #19: DELETE agent rejects human PAT with 403', async () => {
  const { app, seed } = await makeTestApp();
  const agent = await createAgent(app, seed.sessionCookie);
  const pat = await mintPAT(seed.workspace.id, seed.user.id, [
    'documents:delete', 'documents:read', 'agents:write',
  ]);

  const res = await app.request(`${WS_PATH}/${agent.slug}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${pat}` },
  });
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('HUMAN_PAT_AGENT_LIFECYCLE_HTTP');
});

// ---------------------------------------------------------------------------
// I1 (F shake-out) — agent-bound token reads on the workspace doc list/get
// must be narrowed the same way the event-history H7 guard narrows them.
// Without the guard an allow-listed agent could enumerate sibling agents'
// rows (incl. frontmatter.system_prompt / projects / tools) and all
// workspace triggers via GET / and GET /:slug.
// ---------------------------------------------------------------------------

/** Mint a token bound to a specific agent (agentId set), mirroring the F1/G4 harness. */
async function mintAgentBoundToken(
  workspaceId: string,
  userId: string,
  agentId: string,
  scopes: string[] = ['documents:read'],
): Promise<string> {
  const { token, hash } = newApiToken();
  await realDb.insert(apiTokens).values({
    id: nanoid(),
    workspaceId,
    name: 'agent-bound',
    tokenHash: hash,
    scopes,
    createdBy: userId,
    agentId,
  });
  return token;
}

test('I1: GET ?type=agent with an agent-bound token returns ONLY its own agent (sibling hidden)', async () => {
  const { app, seed } = await makeTestApp();
  // Two distinct agents + a trigger, all created via the session (human) path.
  const aRes = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'Agent A',
    frontmatter: { system_prompt: 'A-secret-prompt', model: 'm', provider: 'anthropic', tools: [] },
  });
  const agentA = (await aRes.json()).data as { id: string; slug: string };
  const bRes = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'Agent B',
    frontmatter: { system_prompt: 'B-secret-prompt', model: 'm', provider: 'anthropic', tools: [] },
  });
  const agentB = (await bRes.json()).data as { id: string; slug: string };
  await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'trigger', title: 'WH Trigger',
    frontmatter: { agent: agentA.slug, schedule: '* * * * *', on_event: null },
  });

  const tokenA = await mintAgentBoundToken(seed.workspace.id, seed.user.id, agentA.id);

  // Agent list — only A comes back.
  const res = await app.request(`${WS_PATH}?type=agent`, {
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  const body = JSON.parse(text);
  expect(body.data).toHaveLength(1);
  expect(body.data[0].id).toBe(agentA.id);
  // B's slug and system_prompt must not appear anywhere in the payload.
  expect(text).not.toContain(agentB.slug);
  expect(text).not.toContain('B-secret-prompt');

  // Trigger list — hidden entirely from a narrowed agent.
  const trigRes = await app.request(`${WS_PATH}?type=trigger`, {
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  expect(trigRes.status).toBe(200);
  expect((await trigRes.json()).data).toHaveLength(0);
});

test('I1: GET /:slug with an agent-bound token — 404 for a sibling agent, 200 for self, 404 for a trigger', async () => {
  const { app, seed } = await makeTestApp();
  const aRes = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'Agent A',
    frontmatter: { system_prompt: 'A-secret-prompt', model: 'm', provider: 'anthropic', tools: [] },
  });
  const agentA = (await aRes.json()).data as { id: string; slug: string };
  const bRes = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'Agent B',
    frontmatter: { system_prompt: 'B-secret-prompt', model: 'm', provider: 'anthropic', tools: [] },
  });
  const agentB = (await bRes.json()).data as { id: string; slug: string };
  const trigRes = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'trigger', title: 'WH Trigger',
    frontmatter: { agent: agentA.slug, schedule: '* * * * *', on_event: null },
  });
  const trigger = (await trigRes.json()).data as { slug: string };

  const tokenA = await mintAgentBoundToken(seed.workspace.id, seed.user.id, agentA.id);

  // Sibling agent → 404 DOCUMENT_NOT_FOUND (no system_prompt leak).
  const siblingRes = await app.request(`${WS_PATH}/${agentB.slug}`, {
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  expect(siblingRes.status).toBe(404);
  expect((await siblingRes.json()).error.code).toBe('DOCUMENT_NOT_FOUND');

  // Self → 200 (an agent may read its own row).
  const selfRes = await app.request(`${WS_PATH}/${agentA.slug}`, {
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  expect(selfRes.status).toBe(200);
  expect((await selfRes.json()).data.id).toBe(agentA.id);

  // Trigger → 404 (workspace-wide ops metadata hidden from narrowed agents).
  const trigGetRes = await app.request(`${WS_PATH}/${trigger.slug}`, {
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  expect(trigGetRes.status).toBe(404);
  expect((await trigGetRes.json()).error.code).toBe('DOCUMENT_NOT_FOUND');
});

test('I1 regression: a SESSION (human) request to the list still returns ALL agents + the trigger', async () => {
  const { app, seed } = await makeTestApp();
  await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'Agent A',
    frontmatter: { system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [] },
  });
  await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'Agent B',
    frontmatter: { system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [] },
  });
  await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'trigger', title: 'WH Trigger',
    frontmatter: { agent: 'agent-a', schedule: '* * * * *', on_event: null },
  });

  const agentsRes = await app.request(`${WS_PATH}?type=agent`, { headers: { Cookie: seed.sessionCookie } });
  expect((await agentsRes.json()).data).toHaveLength(2);
  const trigRes = await app.request(`${WS_PATH}?type=trigger`, { headers: { Cookie: seed.sessionCookie } });
  expect((await trigRes.json()).data).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// Phase B B8 — __system library agents surface (badged library:true) in every
// workspace's agent listing.
// ---------------------------------------------------------------------------

import { SYSTEM_WORKSPACE_SLUG } from '../lib/system-workspace.ts';
import { listWorkspaceDocuments as listWorkspaceDocsService } from '../services/documents.ts';
import { workspaces as realWorkspaces } from '../db/schema.ts';

/** Seed the __system workspace + a library agent directly (bypasses bootstrap). */
async function seedSystemLibraryAgent(workspaceUserId: string, slug: string): Promise<string> {
  const systemId = nanoid();
  await realDb.insert(realWorkspaces).values({
    id: systemId,
    slug: SYSTEM_WORKSPACE_SLUG,
    name: 'System Library',
  });
  const agentId = nanoid();
  await realDb.insert(documentsTable).values({
    id: agentId,
    workspaceId: systemId,
    projectId: null,
    tableId: null,
    type: 'agent',
    slug,
    title: slug,
    status: null,
    body: 'Library operator.',
    frontmatter: {
      system_prompt: 'You are the operator.',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      tools: [],
      projects: ['*'],
    },
    createdBy: workspaceUserId,
    updatedBy: workspaceUserId,
  });
  return systemId;
}

test('GET /w/:wslug/documents?type=agent includes __system library agents badged library:true (B8 listing)', async () => {
  const { app, seed } = await makeTestApp();
  await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'Local Helper',
    frontmatter: { system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [] },
  });
  await seedSystemLibraryAgent(seed.user.id, 'operator');

  const res = await app.request(`${WS_PATH}?type=agent`, { headers: { Cookie: seed.sessionCookie } });
  const data = (await res.json()).data as Array<{ slug: string; library?: boolean }>;
  expect(data).toHaveLength(2);
  const local = data.find((d) => d.slug === 'local-helper');
  const library = data.find((d) => d.slug === 'operator');
  expect(local?.library).toBe(false);
  expect(library?.library).toBe(true);
});

test('a workspace-local agent shadows a __system agent of the same slug in the listing (local wins)', async () => {
  const { app, seed } = await makeTestApp();
  await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'dup',
    frontmatter: { system_prompt: 'local', model: 'm', provider: 'anthropic', tools: [] },
  });
  await seedSystemLibraryAgent(seed.user.id, 'dup');

  const res = await app.request(`${WS_PATH}?type=agent`, { headers: { Cookie: seed.sessionCookie } });
  const data = (await res.json()).data as Array<{ slug: string; workspaceId: string; library?: boolean }>;
  const dups = data.filter((d) => d.slug === 'dup');
  expect(dups).toHaveLength(1);
  // The local one wins → not badged library, and homed in the workspace.
  expect(dups[0]?.library).toBe(false);
  expect(dups[0]?.workspaceId).toBe(seed.workspace.id);
});

test('an agent-bound token still sees only itself, not __system library agents (I1 guard preserved)', async () => {
  const { app, seed } = await makeTestApp();
  const parentRes = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'Self Agent',
    frontmatter: { system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [], projects: ['*'] },
  });
  const parent = (await parentRes.json()).data as { id: string };
  await seedSystemLibraryAgent(seed.user.id, 'operator');

  const { token, hash } = newApiToken();
  await realDb.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    name: 'self-bound',
    tokenHash: hash,
    scopes: ['documents:read'],
    createdBy: seed.user.id,
    agentId: parent.id,
  });

  const res = await app.request(`${WS_PATH}?type=agent`, { headers: { Authorization: `Bearer ${token}` } });
  const data = (await res.json()).data as Array<{ id: string }>;
  expect(data).toHaveLength(1);
  expect(data[0]?.id).toBe(parent.id);
});

test('listing __system itself does not double-union its own agents', async () => {
  const { db, seed } = await makeTestApp();
  const systemId = await seedSystemLibraryAgent(seed.user.id, 'operator');

  const rows = await listWorkspaceDocsService({ workspaceId: systemId, type: 'agent' });
  expect(rows.filter((r) => r.slug === 'operator')).toHaveLength(1);
  expect(rows).toHaveLength(1);
  // sanity: db handle is the same realDb proxy the route uses
  expect(db).toBeDefined();
});

// Phase D D3 (inherited Phase A M6) — a non-`__system`-member's DIRECT request
// for `__system` content is 403'd by the membership gate in `resolveWorkspace`
// (apps/server/src/middleware/scope.ts). The seed user is a member of `acme`
// only; `seedSystemLibraryAgent` creates the `__system` workspace + a library
// agent but adds NO membership for the seed user. So a direct GET on a
// `__system` content route must fail closed with FORBIDDEN 'not a member'.
// This is the server-side floor under D1's switcher filter: even if a client
// hand-crafted the URL, the content stays gated.
test('D3: non-member direct GET /w/__system/documents?type=agent is 403 FORBIDDEN (not a member)', async () => {
  const { app, seed } = await makeTestApp();
  await seedSystemLibraryAgent(seed.user.id, 'operator');

  // Sanity: the same user CAN reach their own workspace's content (the gate
  // is membership, not a blanket block on the route).
  const okRes = await app.request('/api/v1/w/acme/documents?type=agent', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(okRes.status).toBe(200);

  // The boundary: a non-member of `__system` hits the membership gate.
  const res = await app.request(`/api/v1/w/${SYSTEM_WORKSPACE_SLUG}/documents?type=agent`, {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.error.code).toBe('FORBIDDEN');
  expect(body.error.message).toBe('not a member');
});

// Phase D D4 — the cross-workspace agent listing unions in `__system` library
// agents so they appear in B's pickers, but a non-`__system`-member must see
// ONLY the INVOKABLE fields of a library agent (id/slug/title/library:true) —
// NEVER its prompt (`body`, post the Phase-3 body-as-prompt change) or any
// legacy `frontmatter.system_prompt`. The picker only needs name/slug/id to
// invoke it. Cross-tenant content (the operator's instructions) must not leak.
// Redaction is LIBRARY-ROWS-ONLY: the workspace's OWN agents keep their body
// (the member legitimately authored + edits them).
test('D4: cross-workspace agent list exposes only invokable fields of a __system agent, not its prompt', async () => {
  const { app, seed } = await makeTestApp();
  // A workspace-local agent — its body MUST survive (redaction is library-only).
  await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'Local Helper', body: 'Local agent prompt body.',
    frontmatter: { system_prompt: 'local sp', model: 'm', provider: 'anthropic', tools: [] },
  });
  // The library agent — seeded with body 'Library operator.' + system_prompt
  // 'You are the operator.' (see seedSystemLibraryAgent). The test FAILS if
  // either leaks through the cross-workspace listing.
  await seedSystemLibraryAgent(seed.user.id, 'operator');

  const res = await app.request(`${WS_PATH}?type=agent`, { headers: { Cookie: seed.sessionCookie } });
  const data = (await res.json()).data as Array<{
    slug: string;
    id: string;
    title: string;
    body: string;
    library?: boolean;
    frontmatter: Record<string, unknown>;
  }>;

  const library = data.find((d) => d.slug === 'operator');
  // Invokable fields present.
  expect(library).toBeDefined();
  expect(library?.library).toBe(true);
  expect(library?.id).toBeTruthy();
  expect(library?.title).toBe('operator');
  // Prompt redacted: body emptied, frontmatter.system_prompt removed.
  expect(library?.body).toBe('');
  expect(library?.frontmatter.system_prompt).toBeUndefined();

  // The workspace's OWN agent keeps its body + system_prompt (library-only redaction).
  const local = data.find((d) => d.slug === 'local-helper');
  expect(local).toBeDefined();
  expect(local?.library).toBe(false);
  expect(local?.body).toBe('Local agent prompt body.');
  expect(local?.frontmatter.system_prompt).toBe('local sp');
});
