/**
 * Operator cockpit chat — Task 6 (conversation routes + M14 CAS).
 *
 * TIER A (route auth guards + the single-active-turn concurrency CAS = security-
 * critical). RED-first, denial paths first:
 *   - M11: user B cannot read user A's conversation / .md export → 404.
 *   - M14: two concurrent POST .../messages → exactly ONE starts a run, the other
 *     409 OPERATOR_BUSY (the M14 must-pass).
 *   - Inv 4: the routes are session-only (mocked runner — no real provider).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { nanoid } from 'nanoid';
import { eq } from 'drizzle-orm';
import { makeTestApp } from '../test/harness.ts';
import * as schema from '../db/schema.ts';
import { createSession } from '../lib/auth.ts';
import { FOLIO_SKILL_BODY, FOLIO_SKILL_SLUG } from '../lib/system-skills.ts';
import { __setRunAgentForTest } from './conversations.ts';
import { appendMessage } from '../services/conversations.ts';
import { recordPendingOp } from '../services/pending-ops.ts';

let runAgentCalls: string[] = [];

beforeEach(() => {
  runAgentCalls = [];
  // Counting stub — never executes a real provider; never clears the slot (so the
  // M14 loser stays rejected). Returns immediately.
  __setRunAgentForTest(async ({ runId }) => {
    runAgentCalls.push(runId);
  });
});

afterEach(() => {
  __setRunAgentForTest(undefined);
});

async function setup() {
  const ctx = await makeTestApp();
  // Operator skill (T13 seeds in prod) — createConversationRun → loadContext
  // hard-fails MISSING_SKILL without it. The runner is mocked, but startTurn
  // calls createConversationRun synchronously before the kick.
  await ctx.db.insert(schema.instanceSkills).values({
    id: nanoid(),
    name: FOLIO_SKILL_SLUG,
    body: FOLIO_SKILL_BODY,
    trusted: true,
  });
  return ctx;
}

async function seedRoleSession(
  db: Awaited<ReturnType<typeof makeTestApp>>['db'],
  role: 'owner' | 'admin' | 'member',
): Promise<{ userId: string; cookie: string }> {
  const userId = nanoid();
  await db.insert(schema.users).values({
    id: userId,
    email: `${userId}@test.local`,
    name: role,
    role,
  });
  const session = await createSession(userId);
  return { userId, cookie: `folio_session=${session.id}` };
}

describe('POST /conversations', () => {
  test('creates a conversation owned by the session user', async () => {
    const { app, db, seed } = await setup();
    const res = await app.request('/api/v1/conversations', {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'My chat' }),
    });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    const row = await db.query.conversations.findFirst({
      where: eq(schema.conversations.id, data.id),
    });
    expect(row?.createdBy).toBe(seed.user.id);
  });

  test('session-only — no cookie → 401', async () => {
    const { app } = await setup();
    const res = await app.request('/api/v1/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /conversations/:id/messages — start a turn', () => {
  test('appends the user message, acquires the slot, kicks the runner once', async () => {
    const { app, db, seed } = await setup();
    const create = await app.request('/api/v1/conversations', {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const { data: conv } = await create.json();

    const res = await app.request(`/api/v1/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'set up a CRM project' }),
    });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(typeof data.runId).toBe('string');

    // The user message is persisted.
    const msgs = await db.query.messages.findMany({
      where: eq(schema.messages.conversationId, conv.id),
    });
    expect(msgs.some((m) => m.role === 'user' && m.body === 'set up a CRM project')).toBe(true);

    // The slot was acquired with the run id, and the runner was kicked once.
    const row = await db.query.conversations.findFirst({
      where: eq(schema.conversations.id, conv.id),
    });
    expect(row?.activeRunId).toBe(data.runId);
    expect(runAgentCalls).toEqual([data.runId]);
  });
});

describe('M14 — single-active-turn CAS (the double-send race)', () => {
  test('two concurrent posts → exactly one run starts, the other gets 409', async () => {
    const { app, seed } = await setup();
    const create = await app.request('/api/v1/conversations', {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const { data: conv } = await create.json();

    const post = () =>
      app.request(`/api/v1/conversations/${conv.id}/messages`, {
        method: 'POST',
        headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'go' }),
      });

    const [a, b] = await Promise.all([post(), post()]);
    const statuses = [a.status, b.status].sort();
    // Exactly one 200, exactly one 409 OPERATOR_BUSY.
    expect(statuses).toEqual([200, 409]);
    // And the runner was kicked EXACTLY once (the loser never starts a run).
    expect(runAgentCalls.length).toBe(1);
  });
});

describe('POST .../messages/:messageId/click — choice-card button (M7/M8)', () => {
  async function makeCardConversation(
    app: Awaited<ReturnType<typeof setup>>['app'],
    db: Awaited<ReturnType<typeof setup>>['db'],
    cookie: string,
  ): Promise<string> {
    const create = await app.request('/api/v1/conversations', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const { data: conv } = await create.json();
    return conv.id;
  }

  test('M8: an out-of-set optionId is rejected (400)', async () => {
    const { app, db, seed } = await setup();
    const convId = await makeCardConversation(app, db, seed.sessionCookie);
    const card = await appendMessage(db, {
      conversationId: convId,
      role: 'operator',
      kind: 'component',
      payload: { type: 'choice_card', prompt: 'Which?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    });
    const res = await app.request(`/api/v1/conversations/${convId}/messages/${card.id}/click`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ optionId: 'NOT_IN_SET' }),
    });
    expect(res.status).toBe(400);
    expect(runAgentCalls.length).toBe(0);
  });

  test('confirmation "yes" confirms the pending op and starts a turn', async () => {
    const { app, db, seed } = await setup();
    const convId = await makeCardConversation(app, db, seed.sessionCookie);
    const pending = await recordPendingOp(db, {
      conversationId: convId,
      callerId: seed.user.id,
      op: 'delete_document',
      params: { slug: 'acme' },
      target: 'acme',
    });
    const card = await appendMessage(db, {
      conversationId: convId,
      role: 'operator',
      kind: 'component',
      payload: {
        type: 'choice_card',
        prompt: 'Confirm delete_document?',
        options: [{ id: pending.id, label: 'Yes, do it' }, { id: 'cancel', label: 'Cancel' }],
        pending_op: pending.id,
      },
    });
    const res = await app.request(`/api/v1/conversations/${convId}/messages/${card.id}/click`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ optionId: pending.id }),
    });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.confirmed).toBe(true);
    expect(typeof data.runId).toBe('string');
    // The pending op is now confirmed (single-use flip).
    const row = await db.query.pendingOps.findFirst({
      where: eq(schema.pendingOps.id, pending.id),
    });
    expect(row?.status).toBe('confirmed');
    expect(runAgentCalls.length).toBe(1);
  });

  test('M7 foreign-user: user B cannot confirm user A pending op (404 conversation)', async () => {
    const { app, db, seed } = await setup();
    const convId = await makeCardConversation(app, db, seed.sessionCookie);
    const pending = await recordPendingOp(db, {
      conversationId: convId,
      callerId: seed.user.id,
      op: 'delete_document',
      params: { slug: 'acme' },
      target: 'acme',
    });
    const card = await appendMessage(db, {
      conversationId: convId,
      role: 'operator',
      kind: 'component',
      payload: {
        type: 'choice_card',
        prompt: 'Confirm?',
        options: [{ id: pending.id, label: 'Yes' }, { id: 'cancel', label: 'Cancel' }],
        pending_op: pending.id,
      },
    });
    const b = await seedRoleSession(db, 'member');
    const res = await app.request(`/api/v1/conversations/${convId}/messages/${card.id}/click`, {
      method: 'POST',
      headers: { Cookie: b.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ optionId: pending.id }),
    });
    // Foreign user can't even see the conversation → 404, no confirm, no turn.
    expect(res.status).toBe(404);
    const row = await db.query.pendingOps.findFirst({
      where: eq(schema.pendingOps.id, pending.id),
    });
    expect(row?.status).toBe('pending');
    expect(runAgentCalls.length).toBe(0);
  });

  test('cancel on a confirmation card rejects the pending op, no turn', async () => {
    const { app, db, seed } = await setup();
    const convId = await makeCardConversation(app, db, seed.sessionCookie);
    const pending = await recordPendingOp(db, {
      conversationId: convId,
      callerId: seed.user.id,
      op: 'delete_document',
      params: { slug: 'acme' },
      target: 'acme',
    });
    const card = await appendMessage(db, {
      conversationId: convId,
      role: 'operator',
      kind: 'component',
      payload: {
        type: 'choice_card',
        prompt: 'Confirm?',
        options: [{ id: pending.id, label: 'Yes' }, { id: 'cancel', label: 'Cancel' }],
        pending_op: pending.id,
      },
    });
    const res = await app.request(`/api/v1/conversations/${convId}/messages/${card.id}/click`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ optionId: 'cancel' }),
    });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.confirmed).toBe(false);
    const row = await db.query.pendingOps.findFirst({
      where: eq(schema.pendingOps.id, pending.id),
    });
    expect(row?.status).toBe('rejected');
    expect(runAgentCalls.length).toBe(0);
  });

  test('a card already chosen rejects a second click (409)', async () => {
    const { app, db, seed } = await setup();
    const convId = await makeCardConversation(app, db, seed.sessionCookie);
    const card = await appendMessage(db, {
      conversationId: convId,
      role: 'operator',
      kind: 'component',
      payload: { type: 'choice_card', prompt: 'Which?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    });
    const first = await app.request(`/api/v1/conversations/${convId}/messages/${card.id}/click`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ optionId: 'a' }),
    });
    expect(first.status).toBe(200);
    const second = await app.request(`/api/v1/conversations/${convId}/messages/${card.id}/click`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ optionId: 'b' }),
    });
    expect(second.status).toBe(409);
  });
});

describe('GET /conversations/recent — most-recent id for auto-resume', () => {
  test('returns the session user most-recent conversation id (newer wins)', async () => {
    const { app, db, seed } = await setup();
    const older = await app.request('/api/v1/conversations', {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'older' }),
    });
    const { data: a } = await older.json();
    const newer = await app.request('/api/v1/conversations', {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'newer' }),
    });
    const { data: b } = await newer.json();

    // Force a deterministic ordering — the two creates can land in the same ms.
    await db
      .update(schema.conversations)
      .set({ updatedAt: new Date(1000) })
      .where(eq(schema.conversations.id, a.id));
    await db
      .update(schema.conversations)
      .set({ updatedAt: new Date(2000) })
      .where(eq(schema.conversations.id, b.id));

    const res = await app.request('/api/v1/conversations/recent', {
      headers: { Cookie: seed.sessionCookie },
    });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.id).toBe(b.id);
  });

  test('M11: does NOT return another user newer conversation (owner-scoped)', async () => {
    const { app, db, seed } = await setup();
    // User A creates one (older).
    const aCreate = await app.request('/api/v1/conversations', {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'A own' }),
    });
    const { data: aConv } = await aCreate.json();

    // User B creates one that is GLOBALLY newer.
    const b = await seedRoleSession(db, 'member');
    const bCreate = await app.request('/api/v1/conversations', {
      method: 'POST',
      headers: { Cookie: b.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'B own' }),
    });
    const { data: bConv } = await bCreate.json();

    await db
      .update(schema.conversations)
      .set({ updatedAt: new Date(1000) })
      .where(eq(schema.conversations.id, aConv.id));
    await db
      .update(schema.conversations)
      .set({ updatedAt: new Date(9999) })
      .where(eq(schema.conversations.id, bConv.id));

    // A's /recent returns A's OWN conversation, never B's globally-newer one.
    const res = await app.request('/api/v1/conversations/recent', {
      headers: { Cookie: seed.sessionCookie },
    });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.id).toBe(aConv.id);
    expect(data.id).not.toBe(bConv.id);
  });

  test('returns { id: null } when the user has no conversation', async () => {
    const { app, db } = await setup();
    const fresh = await seedRoleSession(db, 'member');
    const res = await app.request('/api/v1/conversations/recent', {
      headers: { Cookie: fresh.cookie },
    });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.id).toBe(null);
  });

  test('session-only — no cookie → 401', async () => {
    const { app } = await setup();
    const res = await app.request('/api/v1/conversations/recent');
    expect(res.status).toBe(401);
  });
});

describe('M11 — owner-scoped reads (foreign user → 404)', () => {
  test('user B cannot GET user A conversation', async () => {
    const { app, seed, db } = await setup();
    const create = await app.request('/api/v1/conversations', {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const { data: conv } = await create.json();

    const b = await seedRoleSession(db, 'member');
    const res = await app.request(`/api/v1/conversations/${conv.id}`, {
      headers: { Cookie: b.cookie },
    });
    expect(res.status).toBe(404);

    // Owner CAN read it.
    const ownerRes = await app.request(`/api/v1/conversations/${conv.id}`, {
      headers: { Cookie: seed.sessionCookie },
    });
    expect(ownerRes.status).toBe(200);
  });

  test('GET /:id/stream is owner-scoped — foreign user → 404 before subscribing', async () => {
    const { app, seed, db } = await setup();
    const create = await app.request('/api/v1/conversations', {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const { data: conv } = await create.json();

    // Foreign user — 404 (owner-gate fires before any conversationBus.subscribe).
    const b = await seedRoleSession(db, 'member');
    const foreign = await app.request(`/api/v1/conversations/${conv.id}/stream`, {
      headers: { Cookie: b.cookie },
    });
    expect(foreign.status).toBe(404);

    // Owner — 200 SSE. Open with an abort controller and tear it down at once so
    // the long-lived stream doesn't hang the test (live delivery is covered by
    // the conversation-bus + web tests, not this in-process SSE read).
    const ac = new AbortController();
    const owner = await app.request(`/api/v1/conversations/${conv.id}/stream`, {
      headers: { Cookie: seed.sessionCookie, Accept: 'text/event-stream' },
      signal: ac.signal,
    });
    expect(owner.status).toBe(200);
    expect(owner.headers.get('content-type')).toContain('text/event-stream');
    ac.abort();
    await owner.body?.cancel().catch(() => {});
  });

  test('user B cannot GET user A .md export; owner can', async () => {
    const { app, seed, db } = await setup();
    const create = await app.request('/api/v1/conversations', {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const { data: conv } = await create.json();
    // Seed one turn so the export is non-trivial.
    await app.request(`/api/v1/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello operator' }),
    });

    const b = await seedRoleSession(db, 'member');
    const foreign = await app.request(`/api/v1/conversations/${conv.id}.md`, {
      headers: { Cookie: b.cookie },
    });
    expect(foreign.status).toBe(404);

    const owner = await app.request(`/api/v1/conversations/${conv.id}.md`, {
      headers: { Cookie: seed.sessionCookie },
    });
    expect(owner.status).toBe(200);
    expect(owner.headers.get('content-type')).toContain('text/markdown');
    const md = await owner.text();
    expect(md).toContain('hello operator');
  });
});
