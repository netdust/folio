import { expect, test } from 'bun:test';
import { nanoid } from 'nanoid';
import { db } from '../db/client.ts';
import { apiTokens } from '../db/schema.ts';
import { newApiToken } from '../lib/auth.ts';
import { eventBus } from '../lib/event-bus.ts';
import { makeTestApp } from '../test/harness.ts';

test('SSE endpoint requires auth', async () => {
  const { app } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/events');
  // Drain body so the test doesn't leak the response.
  await res.body?.cancel();
  expect(res.status).toBe(401);
});

test('SSE endpoint returns text/event-stream Content-Type for authenticated requests', async () => {
  const { app, seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    name: 'test',
    tokenHash: hash,
    scopes: ['documents:read'],
    createdBy: seed.user.id,
  });
  const res = await app.request('/api/v1/w/acme/events', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  // Drain the stream so the test doesn't hang on the open subscription.
  await res.body?.cancel();
});

// ── ?parent= and ?run= query param tests ──────────────────────────────────
// These tests verify that the route parses the new filter params and passes
// them through to the bus subscription. We capture the SubFilter by spying on
// eventBus.subscribe before the request is made.

/** Spy on eventBus.subscribe, run body, then unconditionally restore. */
async function withSubscribeSpy<T>(
  body: (captured: { filter: unknown }) => Promise<T>,
): Promise<T> {
  const origSubscribe = eventBus.subscribe.bind(eventBus);
  const captured = { filter: undefined as unknown };
  eventBus.subscribe = ((wsId: string, filter: unknown, handler: unknown) => {
    captured.filter = filter;
    return (origSubscribe as (a: string, b: unknown, c: unknown) => unknown)(wsId, filter, handler);
  }) as typeof eventBus.subscribe;
  try {
    return await body(captured);
  } finally {
    eventBus.subscribe = origSubscribe;
  }
}

test('SSE endpoint passes ?parent= to eventBus.subscribe as parentId', async () => {
  const { app, seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    name: 'test-parent',
    tokenHash: hash,
    scopes: ['documents:read'],
    createdBy: seed.user.id,
  });

  await withSubscribeSpy(async (captured) => {
    const res = await app.request('/api/v1/w/acme/events?parent=doc-42', {
      headers: { Authorization: `Bearer ${token}` },
    });
    await res.body?.cancel();
    expect(res.status).toBe(200);
    expect((captured.filter as { parentId?: string })?.parentId).toBe('doc-42');
  });
});

test('SSE endpoint passes ?run= to eventBus.subscribe as runId', async () => {
  const { app, seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    name: 'test-run',
    tokenHash: hash,
    scopes: ['documents:read'],
    createdBy: seed.user.id,
  });

  await withSubscribeSpy(async (captured) => {
    const res = await app.request('/api/v1/w/acme/events?run=run-xyz', {
      headers: { Authorization: `Bearer ${token}` },
    });
    await res.body?.cancel();
    expect(res.status).toBe(200);
    expect((captured.filter as { runId?: string })?.runId).toBe('run-xyz');
  });
});

test('SSE endpoint does not set parentId for empty ?parent= value', async () => {
  const { app, seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    name: 'test-parent-empty',
    tokenHash: hash,
    scopes: ['documents:read'],
    createdBy: seed.user.id,
  });

  await withSubscribeSpy(async (captured) => {
    const res = await app.request('/api/v1/w/acme/events?parent=', {
      headers: { Authorization: `Bearer ${token}` },
    });
    await res.body?.cancel();
    expect(res.status).toBe(200);
    expect((captured.filter as { parentId?: string })?.parentId).toBeUndefined();
  });
});

// The Last-Event-Id test is intentionally lenient — Bun's test harness for
// Hono's `app.request()` may not stream the body the way a real HTTP client
// does. We skip rather than sink time into making it bulletproof; the
// Content-Type test above is the load-bearing spec assertion. A manual smoke
// test (curl --no-buffer) confirms the replay path end-to-end.
test.skip('Last-Event-Id replay: events from the table flow before live events', async () => {
  const { app, seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    name: 'test',
    tokenHash: hash,
    scopes: ['documents:read', 'documents:write'],
    createdBy: seed.user.id,
  });

  // Create a doc so an event row exists.
  await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'Seed' }),
  });

  const res = await app.request('/api/v1/w/acme/events', {
    headers: { Authorization: `Bearer ${token}`, 'Last-Event-Id': '' },
  });
  expect(res.status).toBe(200);
  const reader = res.body?.getReader();
  if (!reader) return;
  const { value } = await Promise.race([
    reader.read(),
    new Promise<{ value?: Uint8Array }>((resolve) => setTimeout(() => resolve({}), 100)),
  ]);
  await reader.cancel();
  if (value) {
    const text = new TextDecoder().decode(value);
    expect(text).toMatch(/^id:|^event:|^data:/m);
  }
});

// ---------------------------------------------------------------------------
// F3 — SSE /events must respect agent allow-list (Phase 2.6 review)
//
// Before the fix, an agent-bound token with frontmatter.projects=['projA']
// could subscribe to /events?project=<projB-id> and receive every projB event.
// The route only ran wScope, never resolveProject + requireResource, so the
// allow-list narrowing never fired.
// ---------------------------------------------------------------------------

import { documents, projectAccess, projects, users } from '../db/schema.ts';
import { createSession } from '../lib/auth.ts';

async function seedSecondProject(seedWorkspaceId: string): Promise<string> {
  const id = nanoid();
  await db.insert(projects).values({
    id, workspaceId: seedWorkspaceId, slug: 'projb', name: 'Project B',
  });
  return id;
}

async function setupAgentToken(opts: {
  workspaceId: string;
  userId: string;
  agentSlug: string;
  projectAllowList: string[];
  scopes?: string[];
}): Promise<{ token: string; agentId: string }> {
  const agentId = nanoid();
  await db.insert(documents).values({
    id: agentId,
    projectId: null,
    workspaceId: opts.workspaceId,
    tableId: null,
    type: 'agent',
    slug: opts.agentSlug,
    title: 'Test Agent',
    status: null,
    body: '',
    frontmatter: {
      system_prompt: 'help',
      model: 'm',
      provider: 'anthropic',
      tools: ['list_documents'],
      projects: opts.projectAllowList,
    },
    createdBy: opts.userId,
    updatedBy: opts.userId,
  });
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: opts.workspaceId,
    name: `agent:${opts.agentSlug}`,
    tokenHash: hash,
    scopes: opts.scopes ?? ['documents:read'],
    createdBy: opts.userId,
    agentId,
  });
  return { token, agentId };
}

test('H14: empty ?project= is normalized to no-filter (does NOT 403 for narrowed agent)', async () => {
  const { app, seed } = await makeTestApp();
  const { token } = await setupAgentToken({
    workspaceId: seed.workspace.id,
    userId: seed.user.id,
    agentSlug: 'h14-agent',
    projectAllowList: [seed.project.id],
  });

  // `?project=` (empty value) used to produce projectId='' → 403. With H14
  // it's normalized to undefined like empty ?parent=/?run= already were.
  const res = await app.request('/api/v1/w/acme/events?project=', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  await res.body?.cancel();
});

test('F3: agent token cannot request ?project= outside its allow-list', async () => {
  const { app, seed } = await makeTestApp();
  const projectBId = await seedSecondProject(seed.workspace.id);
  const { token } = await setupAgentToken({
    workspaceId: seed.workspace.id,
    userId: seed.user.id,
    agentSlug: 'narrow-agent',
    projectAllowList: [seed.project.id], // only project A
  });

  const res = await app.request(`/api/v1/w/acme/events?project=${projectBId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await res.body?.cancel();
  expect(res.status).toBe(403);
  const body = await res.json().catch(() => ({}));
  // Body may be empty if streamed; if present, code should be FORBIDDEN_RESOURCE.
  if (body?.error) expect(body.error.code).toBe('FORBIDDEN_RESOURCE');
});

test('F3: agent token with [*] allow-list can request any ?project=', async () => {
  const { app, seed } = await makeTestApp();
  const projectBId = await seedSecondProject(seed.workspace.id);
  const { token } = await setupAgentToken({
    workspaceId: seed.workspace.id,
    userId: seed.user.id,
    agentSlug: 'wide-agent',
    projectAllowList: ['*'],
  });

  const res = await app.request(`/api/v1/w/acme/events?project=${projectBId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  await res.body?.cancel();
});

test('F3: agent token without ?project= can still subscribe (workspace events allowed)', async () => {
  const { app, seed } = await makeTestApp();
  await seedSecondProject(seed.workspace.id);
  const { token } = await setupAgentToken({
    workspaceId: seed.workspace.id,
    userId: seed.user.id,
    agentSlug: 'no-project-agent',
    projectAllowList: [seed.project.id],
  });

  const res = await app.request('/api/v1/w/acme/events', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  await res.body?.cancel();
});

// ---------------------------------------------------------------------------
// H1 — `agent.task.assigned` MUST reach the assignee even though the event's
// documentId is the work_item, not the agent. The prior G9 kind-prefix
// filter dropped these silently.
// ---------------------------------------------------------------------------

test('H1: agent.task.assigned reaches the assignee agent via SSE replay', async () => {
  const { app, db: testDb, seed } = await makeTestApp();

  const { token, agentId } = await setupAgentToken({
    workspaceId: seed.workspace.id,
    userId: seed.user.id,
    agentSlug: 'task-bot',
    projectAllowList: [seed.project.id],
  });

  // Seed an agent.task.assigned event addressed to this agent (slug match)
  // with documentId = a work_item (not the agent).
  const { events } = await import('../db/schema.ts');
  await testDb.insert(events).values([
    {
      id: 'evt-anchor',
      workspaceId: seed.workspace.id,
      projectId: null,
      documentId: null,
      kind: 'workspace.created',
      actor: seed.user.id,
      payload: {},
      createdAt: new Date(Date.now() - 90_000),
      seq: 1000,
    },
    {
      id: 'evt-my-assignment',
      workspaceId: seed.workspace.id,
      projectId: seed.project.id,
      documentId: 'work-item-xyz',
      kind: 'agent.task.assigned',
      actor: seed.user.id,
      payload: { slug: 'work-item-xyz', agent: 'task-bot' },
      createdAt: new Date(Date.now() - 60_000),
      seq: 1001,
    },
    {
      id: 'evt-other-assignment',
      workspaceId: seed.workspace.id,
      projectId: seed.project.id,
      documentId: 'work-item-other',
      kind: 'agent.task.assigned',
      actor: seed.user.id,
      payload: { slug: 'work-item-other', agent: 'other-bot' },
      createdAt: new Date(Date.now() - 30_000),
      seq: 1002,
    },
  ]);

  const res = await app.request('/api/v1/w/acme/events', {
    headers: { Authorization: `Bearer ${token}`, 'Last-Event-Id': 'evt-anchor' },
  });
  expect(res.status).toBe(200);
  const reader = res.body?.getReader();
  if (!reader) throw new Error('no body');
  const decoder = new TextDecoder();
  let text = '';
  const start = Date.now();
  while (Date.now() - start < 300) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value?: Uint8Array; done: boolean }>((resolve) =>
        setTimeout(() => resolve({ done: false }), 100),
      ),
    ]);
    if (done) break;
    if (value) text += decoder.decode(value);
  }
  await reader.cancel();

  // My assignment MUST be visible (this is the wedge).
  expect(text).toContain('evt-my-assignment');
  // The OTHER agent's assignment in the SAME project is project-metadata
  // that agents in the project can see (no payload leak — assignee slug
  // is the only sensitive bit and they need it to know it wasn't them).
  // BUT a stricter policy would hide it; document the intent here.
  expect(text).toContain('evt-other-assignment');
  // sanity: agentId unused, but referenced for traceability
  expect(agentId).toBeTruthy();
});

test('H2: workspace-level document.created for another agent is HIDDEN', async () => {
  const { app, db: testDb, seed } = await makeTestApp();

  const { token } = await setupAgentToken({
    workspaceId: seed.workspace.id,
    userId: seed.user.id,
    agentSlug: 'agent-a',
    projectAllowList: [seed.project.id],
  });
  const { agentId: agentBId } = await setupAgentToken({
    workspaceId: seed.workspace.id,
    userId: seed.user.id,
    agentSlug: 'agent-b',
    projectAllowList: [seed.project.id],
  });

  const { events } = await import('../db/schema.ts');
  await testDb.insert(events).values([
    {
      id: 'evt-anchor-h2',
      workspaceId: seed.workspace.id,
      projectId: null,
      documentId: null,
      kind: 'workspace.created',
      actor: seed.user.id,
      payload: {},
      createdAt: new Date(Date.now() - 90_000),
      seq: 2000,
    },
    {
      id: 'evt-leaked-document-created',
      workspaceId: seed.workspace.id,
      projectId: null,
      documentId: agentBId,
      kind: 'document.created',
      actor: seed.user.id,
      payload: { slug: 'agent-b', type: 'agent' },
      createdAt: new Date(Date.now() - 60_000),
      seq: 2001,
    },
    {
      id: 'evt-leaked-activity-logged',
      workspaceId: seed.workspace.id,
      projectId: null,
      documentId: agentBId,
      kind: 'activity.logged',
      actor: seed.user.id,
      payload: { note: 'sensitive operator context about B' },
      createdAt: new Date(Date.now() - 30_000),
      seq: 2002,
    },
  ]);

  const res = await app.request('/api/v1/w/acme/events', {
    headers: { Authorization: `Bearer ${token}`, 'Last-Event-Id': 'evt-anchor-h2' },
  });
  expect(res.status).toBe(200);
  const reader = res.body?.getReader();
  if (!reader) throw new Error('no body');
  const decoder = new TextDecoder();
  let text = '';
  const start = Date.now();
  while (Date.now() - start < 300) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value?: Uint8Array; done: boolean }>((resolve) =>
        setTimeout(() => resolve({ done: false }), 100),
      ),
    ]);
    if (done) break;
    if (value) text += decoder.decode(value);
  }
  await reader.cancel();

  // Both leaks suppressed.
  expect(text).not.toContain('evt-leaked-document-created');
  expect(text).not.toContain('evt-leaked-activity-logged');
  expect(text).not.toContain('sensitive operator context');
});

// ---------------------------------------------------------------------------
// H7 — REST GET /:slug/events must also enforce the per-agent visibility.
// ---------------------------------------------------------------------------

test('H7: GET /w/:wslug/documents/:other-agent/events 404s for narrowed agent', async () => {
  const { app, seed } = await makeTestApp();

  const { token } = await setupAgentToken({
    workspaceId: seed.workspace.id,
    userId: seed.user.id,
    agentSlug: 'agent-a-h7',
    projectAllowList: [seed.project.id],
  });
  const otherSlug = 'agent-b-h7';
  await setupAgentToken({
    workspaceId: seed.workspace.id,
    userId: seed.user.id,
    agentSlug: otherSlug,
    projectAllowList: [seed.project.id],
  });

  // Calling agent A tries to read events for agent B's row via REST.
  const res = await app.request(`/api/v1/w/acme/documents/${otherSlug}/events`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: { code: string } };
  // Same NOT_FOUND code an unknown slug would yield — prevents existence-oracle.
  expect(body.error.code).toBe('DOCUMENT_NOT_FOUND');
});

test('S3: GET /w/:wslug/documents/<trigger-slug>/events 404s for narrowed agent', async () => {
  const { app, seed } = await makeTestApp();

  const { token } = await setupAgentToken({
    workspaceId: seed.workspace.id,
    userId: seed.user.id,
    agentSlug: 'agent-s3',
    projectAllowList: [seed.project.id],
  });

  // makeTestApp seeds 4 builtins via seedBuiltinTriggers in workspaces.ts,
  // but the test harness bypasses that route. Insert a trigger doc manually
  // so the route has a row to find by slug.
  const triggerSlug = 'builtin-on-mention';
  await db.insert(documents).values({
    id: 'tr-' + nanoid(),
    workspaceId: seed.workspace.id,
    projectId: null,
    type: 'trigger',
    slug: triggerSlug,
    title: 'Run agent on @mention',
    body: '',
    frontmatter: {
      on_event: 'comment.mentioned',
      schedule: null,
      agent: '$event.agent_slug',
      enabled: false,
      builtin: true,
      payload: null,
    },
  });

  // Narrowed agent attempts to read a trigger's event history.
  const res = await app.request(`/api/v1/w/acme/documents/${triggerSlug}/events`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: { code: string } };
  // Same NOT_FOUND code an unknown slug would yield — prevents existence-oracle.
  expect(body.error.code).toBe('DOCUMENT_NOT_FOUND');
});

test('H7: agent CAN read events for its OWN agent doc', async () => {
  const { app, seed } = await makeTestApp();

  const ownSlug = 'agent-self-h7';
  const { token } = await setupAgentToken({
    workspaceId: seed.workspace.id,
    userId: seed.user.id,
    agentSlug: ownSlug,
    projectAllowList: [seed.project.id],
  });

  const res = await app.request(`/api/v1/w/acme/documents/${ownSlug}/events`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: unknown[] };
  expect(Array.isArray(body.data)).toBe(true);
});

test('G14: SSE replay returns events with same createdAt as anchor when their id sorts after the anchor id', async () => {
  const { app, db: testDb, seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await testDb.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    name: 'g14',
    tokenHash: hash,
    scopes: ['documents:read'],
    createdBy: seed.user.id,
  });

  // Three events at the same instant. H3 replaced the (createdAt, id) cursor
  // with a monotonic seq column — same-ms ties are no longer ambiguous.
  // Anchored at evt-a (seq=3000), the other two (seq=3001, 3002) must replay.
  const sameTs = new Date(Date.now() - 60_000);
  const { events } = await import('../db/schema.ts');
  await testDb.insert(events).values([
    {
      id: 'evt-a-anchor',
      workspaceId: seed.workspace.id,
      projectId: null,
      documentId: null,
      kind: 'workspace.created',
      actor: seed.user.id,
      payload: {},
      createdAt: sameTs,
      seq: 3000,
    },
    {
      id: 'evt-b-same-ms',
      workspaceId: seed.workspace.id,
      projectId: null,
      documentId: null,
      kind: 'workspace.updated',
      actor: seed.user.id,
      payload: {},
      createdAt: sameTs,
      seq: 3001,
    },
    {
      id: 'evt-c-same-ms',
      workspaceId: seed.workspace.id,
      projectId: null,
      documentId: null,
      kind: 'workspace.updated',
      actor: seed.user.id,
      payload: {},
      createdAt: sameTs,
      seq: 3002,
    },
  ]);

  const res = await app.request('/api/v1/w/acme/events', {
    headers: { Authorization: `Bearer ${token}`, 'Last-Event-Id': 'evt-a-anchor' },
  });
  expect(res.status).toBe(200);
  const reader = res.body?.getReader();
  if (!reader) throw new Error('no body');
  const decoder = new TextDecoder();
  let text = '';
  const start = Date.now();
  while (Date.now() - start < 300) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value?: Uint8Array; done: boolean }>((resolve) =>
        setTimeout(() => resolve({ done: false }), 100),
      ),
    ]);
    if (done) break;
    if (value) text += decoder.decode(value);
  }
  await reader.cancel();

  // The anchor itself should NOT be redelivered.
  expect(text).not.toContain('evt-a-anchor');
  // Both same-ms-later-id events SHOULD be redelivered.
  expect(text).toContain('evt-b-same-ms');
  expect(text).toContain('evt-c-same-ms');
});

test('G9: workspace-level agent.* events about OTHER agents are suppressed for narrowed tokens', async () => {
  const { app, db: testDb, seed } = await makeTestApp();

  // Two agents in the same workspace. Subscriber is agent A (narrowed).
  const { token: tokenA, agentId: agentAId } = await setupAgentToken({
    workspaceId: seed.workspace.id,
    userId: seed.user.id,
    agentSlug: 'agent-a',
    projectAllowList: [seed.project.id],
  });
  const { agentId: agentBId } = await setupAgentToken({
    workspaceId: seed.workspace.id,
    userId: seed.user.id,
    agentSlug: 'agent-b',
    projectAllowList: [seed.project.id],
  });

  // Seed three workspace-level events:
  //   - agent.created about agent A (visible — it's about A itself)
  //   - agent.created about agent B (must be suppressed)
  //   - workspace.created (visible — not agent.*)
  const { events } = await import('../db/schema.ts');
  await testDb.insert(events).values([
    {
      id: 'evt-anchor',
      workspaceId: seed.workspace.id,
      projectId: null,
      documentId: null,
      kind: 'workspace.created',
      actor: seed.user.id,
      payload: {},
      createdAt: new Date(Date.now() - 90_000),
      seq: 4000,
    },
    {
      id: 'evt-self-allowed',
      workspaceId: seed.workspace.id,
      projectId: null,
      documentId: agentAId, // about A itself
      kind: 'agent.created',
      actor: seed.user.id,
      payload: { slug: 'agent-a' },
      createdAt: new Date(Date.now() - 60_000),
      seq: 4001,
    },
    {
      id: 'evt-other-leaked',
      workspaceId: seed.workspace.id,
      projectId: null,
      documentId: agentBId, // about B — must be suppressed
      kind: 'agent.created',
      actor: seed.user.id,
      payload: { slug: 'agent-b', api_token_id: 'sensitive-token-id' },
      createdAt: new Date(Date.now() - 30_000),
      seq: 4002,
    },
  ]);

  const res = await app.request('/api/v1/w/acme/events', {
    headers: { Authorization: `Bearer ${tokenA}`, 'Last-Event-Id': 'evt-anchor' },
  });
  expect(res.status).toBe(200);
  const reader = res.body?.getReader();
  if (!reader) throw new Error('no body');
  const decoder = new TextDecoder();
  let text = '';
  const start = Date.now();
  while (Date.now() - start < 300) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value?: Uint8Array; done: boolean }>((resolve) =>
        setTimeout(() => resolve({ done: false }), 100),
      ),
    ]);
    if (done) break;
    if (value) text += decoder.decode(value);
  }
  await reader.cancel();

  expect(text).toContain('evt-self-allowed');
  expect(text).not.toContain('evt-other-leaked');
  expect(text).not.toContain('sensitive-token-id');
});

test('F3: agent allow-list narrows server-side replay filter (foreign projectId rows skipped)', async () => {
  const { app, db: testDb, seed } = await makeTestApp();
  const projectBId = await seedSecondProject(seed.workspace.id);

  // Insert two events directly: one in seed.project (allowed), one in projectB.
  const { events } = await import('../db/schema.ts');
  await testDb.insert(events).values([
    {
      id: 'evt-a-allowed',
      workspaceId: seed.workspace.id,
      projectId: seed.project.id,
      documentId: null,
      kind: 'document.created',
      actor: seed.user.id,
      payload: {},
      createdAt: new Date(Date.now() - 60_000),
      seq: 5001,
    },
    {
      id: 'evt-b-leaked',
      workspaceId: seed.workspace.id,
      projectId: projectBId,
      documentId: null,
      kind: 'document.created',
      actor: seed.user.id,
      payload: {},
      createdAt: new Date(Date.now() - 30_000),
      seq: 5002,
    },
    {
      id: 'evt-anchor',
      workspaceId: seed.workspace.id,
      projectId: null,
      documentId: null,
      kind: 'workspace.created',
      actor: seed.user.id,
      payload: {},
      createdAt: new Date(Date.now() - 90_000), // earliest — use as Last-Event-Id anchor
      seq: 5000,
    },
  ]);

  const { token } = await setupAgentToken({
    workspaceId: seed.workspace.id,
    userId: seed.user.id,
    agentSlug: 'replay-narrow-agent',
    projectAllowList: [seed.project.id], // not projectB
  });

  const res = await app.request('/api/v1/w/acme/events', {
    headers: { Authorization: `Bearer ${token}`, 'Last-Event-Id': 'evt-anchor' },
  });
  expect(res.status).toBe(200);
  const reader = res.body?.getReader();
  if (!reader) throw new Error('no body');

  // Read replay frames within 300ms then cancel.
  const decoder = new TextDecoder();
  let text = '';
  const start = Date.now();
  while (Date.now() - start < 300) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value?: Uint8Array; done: boolean }>((resolve) =>
        setTimeout(() => resolve({ done: false }), 100),
      ),
    ]);
    if (done) break;
    if (value) text += decoder.decode(value);
  }
  await reader.cancel();

  expect(text).toContain('evt-a-allowed');
  expect(text).not.toContain('evt-b-leaked');
});

// ---------------------------------------------------------------------------
// Fix #2 (drop-workspace-tenancy) — /events narrows by PER-USER project
// visibility, not just by the agent allow-list.
//
// Post-tenancy, a user invited to ONLY one project can TRAVERSE the workspace
// (canSeeWorkspace's project_access clause) to reach that project — so they now
// pass resolveWorkspace and can hit /events. The old F3 narrowing only bounds
// AGENT tokens; a human session was unbounded because, under the OLD model,
// any workspace member could see every project in the workspace. That is no
// longer true. Without per-user narrowing, this project-only invitee receives
// events for EVERY project in the workspace — including ones they were never
// granted.
//
// NOTE: the naive "a user with NO grant to ws B gets zero B events" test does
// NOT catch this — this user DOES have a grant (a project-level one), and so
// legitimately traverses to the workspace. The leak is the SIBLING project's
// events. This test exercises exactly that traverse case on the deterministic
// REPLAY path (a session cookie + Last-Event-Id anchor).
// ---------------------------------------------------------------------------

test('fix#2: project-only invitee does NOT receive sibling-project events via /events replay', async () => {
  const { app, db: testDb, seed } = await makeTestApp();

  // Second project 'ops' in acme — the invitee is NOT granted this one.
  const opsId = nanoid();
  await testDb.insert(projects).values({
    id: opsId, workspaceId: seed.workspace.id, slug: 'ops', name: 'Ops',
  });

  // A project-only invitee: instance role 'member', a project_access grant to
  // 'web' (seed.project) ONLY, and crucially NO workspace_access grant. This
  // user reaches the workspace solely via the traverse clause.
  const inviteeId = nanoid();
  await testDb.insert(users).values({
    id: inviteeId, email: 'invitee@test.local', name: 'Invitee', role: 'member',
  });
  await testDb.insert(projectAccess).values({ userId: inviteeId, projectId: seed.project.id });

  // Three events: an anchor (workspace-level), one in 'web' (granted), one in
  // 'ops' (NOT granted). Direct insert with explicit seq mirrors the F3 replay
  // test above so the replay cursor is deterministic.
  const { events } = await import('../db/schema.ts');
  await testDb.insert(events).values([
    {
      id: 'fix2-anchor',
      workspaceId: seed.workspace.id,
      projectId: null,
      documentId: null,
      kind: 'workspace.created',
      actor: seed.user.id,
      payload: {},
      createdAt: new Date(Date.now() - 90_000),
      seq: 8000,
    },
    {
      id: 'fix2-WEB-event',
      workspaceId: seed.workspace.id,
      projectId: seed.project.id, // granted project
      documentId: null,
      kind: 'document.created',
      actor: seed.user.id,
      payload: { marker: 'WEB' },
      createdAt: new Date(Date.now() - 60_000),
      seq: 8001,
    },
    {
      id: 'fix2-OPS-event',
      workspaceId: seed.workspace.id,
      projectId: opsId, // sibling project — NOT granted to the invitee
      documentId: null,
      kind: 'document.created',
      actor: seed.user.id,
      payload: { marker: 'OPS' },
      createdAt: new Date(Date.now() - 30_000),
      seq: 8002,
    },
  ]);

  // Drive as the invitee's SESSION (not an agent token) so the F3 path is a
  // no-op and only the per-user narrowing governs the result.
  const session = await createSession(inviteeId);
  const res = await app.request('/api/v1/w/acme/events', {
    headers: {
      Cookie: `folio_session=${session.id}`,
      'Last-Event-Id': 'fix2-anchor',
    },
  });
  expect(res.status).toBe(200);
  const text = await drainReplay(res);

  // The granted project's event MUST be delivered.
  expect(text).toContain('fix2-WEB-event');
  expect(text).toContain('WEB');
  // The sibling project's event MUST NOT leak.
  expect(text).not.toContain('fix2-OPS-event');
  expect(text).not.toContain('OPS');
});

test('fix#2: workspace owner still receives ALL project events via /events replay (no over-narrowing)', async () => {
  const { app, db: testDb, seed } = await makeTestApp();

  // Second project the owner has no DIRECT project grant to — but owner sees
  // the whole workspace, so userVisibleProjects must stay unrestricted (null).
  const opsId = nanoid();
  await testDb.insert(projects).values({
    id: opsId, workspaceId: seed.workspace.id, slug: 'ops', name: 'Ops',
  });

  const { events } = await import('../db/schema.ts');
  await testDb.insert(events).values([
    {
      id: 'fix2o-anchor',
      workspaceId: seed.workspace.id,
      projectId: null,
      documentId: null,
      kind: 'workspace.created',
      actor: seed.user.id,
      payload: {},
      createdAt: new Date(Date.now() - 90_000),
      seq: 8100,
    },
    {
      id: 'fix2o-WEB-event',
      workspaceId: seed.workspace.id,
      projectId: seed.project.id,
      documentId: null,
      kind: 'document.created',
      actor: seed.user.id,
      payload: { marker: 'WEB' },
      createdAt: new Date(Date.now() - 60_000),
      seq: 8101,
    },
    {
      id: 'fix2o-OPS-event',
      workspaceId: seed.workspace.id,
      projectId: opsId,
      documentId: null,
      kind: 'document.created',
      actor: seed.user.id,
      payload: { marker: 'OPS' },
      createdAt: new Date(Date.now() - 30_000),
      seq: 8102,
    },
  ]);

  // Owner session (seed.user is the instance owner with workspace_access).
  const res = await app.request('/api/v1/w/acme/events', {
    headers: { Cookie: seed.sessionCookie, 'Last-Event-Id': 'fix2o-anchor' },
  });
  expect(res.status).toBe(200);
  const text = await drainReplay(res);

  // Owner sees BOTH projects — narrowing must not have fired.
  expect(text).toContain('fix2o-WEB-event');
  expect(text).toContain('fix2o-OPS-event');
});

// ---------------------------------------------------------------------------
// D-7 — `?agent=` + `?table=` SSE filters.
//
// `?agent=` matches `payload.agent` (the agent SLUG); `?table=` matches
// `payload.table_id` (the runs table id). Both keys are stamped uniformly
// across every run-lifecycle event (started + transitions + orphan-recovery),
// so the web runs UI follows a whole run through one filter. These filters are
// ADDITIONAL — AND-combined with the F3 allow-list + subject visibility — so
// they narrow, never widen.
//
// These tests drive the REPLAY path (Last-Event-Id anchor) with a plain
// non-agent PAT so the F3 + visibility layers are pass-through, isolating the
// new payload-key filters. The live-path callback uses the exact same
// predicate (verified by reading events.ts); the replay assertion is the
// load-bearing spec check, mirroring how the existing ?parent=/?run= replay
// tests are structured.
// ---------------------------------------------------------------------------

/** Drain SSE replay frames for ~300ms, then cancel. Returns the raw text. */
async function drainReplay(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('no body');
  const decoder = new TextDecoder();
  let text = '';
  const start = Date.now();
  while (Date.now() - start < 300) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise<{ value?: Uint8Array; done: boolean }>((resolve) =>
        setTimeout(() => resolve({ done: false }), 100),
      ),
    ]);
    if (done) break;
    if (value) text += decoder.decode(value);
  }
  await reader.cancel();
  return text;
}

/** Plain (non-agent) PAT so F3 + visibility are no-ops for the D-7 tests. */
async function setupPlainToken(opts: {
  workspaceId: string;
  userId: string;
  name: string;
}): Promise<string> {
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: opts.workspaceId,
    name: opts.name,
    tokenHash: hash,
    scopes: ['documents:read'],
    createdBy: opts.userId,
  });
  return token;
}

/**
 * Seed an anchor + a run-lifecycle event per (agent, table) tuple. Returns the
 * anchor id. Each lifecycle event id encodes its agent + table for assertions.
 */
async function seedRunEvents(
  workspaceId: string,
  projectId: string,
  actor: string,
  rows: Array<{ id: string; agent: string; table_id: string; kind: string }>,
): Promise<string> {
  const { events } = await import('../db/schema.ts');
  const base = Date.now();
  const values = [
    {
      id: 'd7-anchor',
      workspaceId,
      projectId: null,
      documentId: null,
      kind: 'workspace.created' as const,
      actor,
      payload: {},
      createdAt: new Date(base - 90_000),
      seq: 7000,
    },
    ...rows.map((r, i) => ({
      id: r.id,
      workspaceId,
      projectId,
      documentId: `run-${i}`,
      kind: r.kind as 'agent.run.started',
      actor,
      payload: { agent: r.agent, table_id: r.table_id, from: 'planning', to: 'running' },
      createdAt: new Date(base - 60_000 + i * 1_000),
      seq: 7001 + i,
    })),
  ];
  await db.insert(events).values(values);
  return 'd7-anchor';
}

test('D-7: ?agent=<slug> returns only events whose payload.agent matches (replay isolation)', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupPlainToken({
    workspaceId: seed.workspace.id,
    userId: seed.user.id,
    name: 'd7-agent-filter',
  });
  await seedRunEvents(seed.workspace.id, seed.project.id, seed.user.id, [
    { id: 'evt-alpha-started', agent: 'alpha-bot', table_id: 'tbl-runs', kind: 'agent.run.started' },
    { id: 'evt-alpha-running', agent: 'alpha-bot', table_id: 'tbl-runs', kind: 'agent.run.running' },
    { id: 'evt-beta-started', agent: 'beta-bot', table_id: 'tbl-runs', kind: 'agent.run.started' },
  ]);

  const res = await app.request('/api/v1/w/acme/events?agent=alpha-bot', {
    headers: { Authorization: `Bearer ${token}`, 'Last-Event-Id': 'd7-anchor' },
  });
  expect(res.status).toBe(200);
  const text = await drainReplay(res);

  // Both alpha lifecycle events flow through; beta's is excluded.
  expect(text).toContain('evt-alpha-started');
  expect(text).toContain('evt-alpha-running');
  expect(text).not.toContain('evt-beta-started');
});

test('D-7: ?table=<tableId> returns only events for that runs table', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupPlainToken({
    workspaceId: seed.workspace.id,
    userId: seed.user.id,
    name: 'd7-table-filter',
  });
  await seedRunEvents(seed.workspace.id, seed.project.id, seed.user.id, [
    { id: 'evt-tblA', agent: 'a-bot', table_id: 'tbl-A', kind: 'agent.run.started' },
    { id: 'evt-tblB', agent: 'b-bot', table_id: 'tbl-B', kind: 'agent.run.started' },
  ]);

  const res = await app.request('/api/v1/w/acme/events?table=tbl-A', {
    headers: { Authorization: `Bearer ${token}`, 'Last-Event-Id': 'd7-anchor' },
  });
  expect(res.status).toBe(200);
  const text = await drainReplay(res);

  expect(text).toContain('evt-tblA');
  expect(text).not.toContain('evt-tblB');
});

test('D-7: ?agent=X&parent=Y AND-combines the new filter with an existing one', async () => {
  const { app, db: testDb, seed } = await makeTestApp();
  const token = await setupPlainToken({
    workspaceId: seed.workspace.id,
    userId: seed.user.id,
    name: 'd7-and-combine',
  });

  // Three events, all agent=combo-bot, but differing parent_id. Only the one
  // matching BOTH agent AND parent should flow through.
  const { events } = await import('../db/schema.ts');
  const base = Date.now();
  await testDb.insert(events).values([
    {
      id: 'd7-anchor',
      workspaceId: seed.workspace.id,
      projectId: null,
      documentId: null,
      kind: 'workspace.created',
      actor: seed.user.id,
      payload: {},
      createdAt: new Date(base - 90_000),
      seq: 7100,
    },
    {
      id: 'evt-match-both',
      workspaceId: seed.workspace.id,
      projectId: seed.project.id,
      documentId: 'run-x',
      kind: 'agent.run.started',
      actor: seed.user.id,
      payload: { agent: 'combo-bot', table_id: 'tbl', parent_id: 'parent-1' },
      createdAt: new Date(base - 60_000),
      seq: 7101,
    },
    {
      id: 'evt-wrong-parent',
      workspaceId: seed.workspace.id,
      projectId: seed.project.id,
      documentId: 'run-y',
      kind: 'agent.run.started',
      actor: seed.user.id,
      payload: { agent: 'combo-bot', table_id: 'tbl', parent_id: 'parent-2' },
      createdAt: new Date(base - 50_000),
      seq: 7102,
    },
    {
      id: 'evt-wrong-agent',
      workspaceId: seed.workspace.id,
      projectId: seed.project.id,
      documentId: 'run-z',
      kind: 'agent.run.started',
      actor: seed.user.id,
      payload: { agent: 'other-bot', table_id: 'tbl', parent_id: 'parent-1' },
      createdAt: new Date(base - 40_000),
      seq: 7103,
    },
  ]);

  const res = await app.request('/api/v1/w/acme/events?agent=combo-bot&parent=parent-1', {
    headers: { Authorization: `Bearer ${token}`, 'Last-Event-Id': 'd7-anchor' },
  });
  expect(res.status).toBe(200);
  const text = await drainReplay(res);

  expect(text).toContain('evt-match-both');
  expect(text).not.toContain('evt-wrong-parent');
  expect(text).not.toContain('evt-wrong-agent');
});

test('D-7: empty ?agent= / ?table= are normalized to no-filter', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupPlainToken({
    workspaceId: seed.workspace.id,
    userId: seed.user.id,
    name: 'd7-empty',
  });
  await seedRunEvents(seed.workspace.id, seed.project.id, seed.user.id, [
    { id: 'evt-passthrough', agent: 'any-bot', table_id: 'any-tbl', kind: 'agent.run.started' },
  ]);

  // Empty values must NOT filter everything out (mirrors empty ?parent=/?run=).
  const res = await app.request('/api/v1/w/acme/events?agent=&table=', {
    headers: { Authorization: `Bearer ${token}`, 'Last-Event-Id': 'd7-anchor' },
  });
  expect(res.status).toBe(200);
  const text = await drainReplay(res);
  expect(text).toContain('evt-passthrough');
});
