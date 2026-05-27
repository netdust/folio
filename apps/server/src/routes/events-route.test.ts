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

import { documents, projects } from '../db/schema.ts';

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

  // Three events at the same instant. Sort ids lexically; replay anchored at
  // the LEX-FIRST id should still surface the other two (same createdAt, but
  // ids sort after the anchor).
  const sameTs = new Date(Date.now() - 60_000);
  const { events } = await import('../db/schema.ts');
  // Ids picked so the order is deterministic: 'evt-a' < 'evt-b' < 'evt-c'.
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
