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
