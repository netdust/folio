import { test, expect } from 'bun:test';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { apiTokens } from '../db/schema.ts';
import { newApiToken } from '../lib/auth.ts';
import { attachToken, requireToken, requireScope, getToken } from './bearer.ts';
import type { AuthContext } from './auth.ts';
import { registerErrorHandler } from '../lib/http.ts';
import { makeTestApp } from '../test/harness.ts';
import { nanoid } from 'nanoid';

function build() {
  const app = new Hono<AuthContext>();
  registerErrorHandler(app);
  app.use('*', attachToken);
  app.get('/optional', (c) => {
    const t = c.get('token');
    return c.json({ has: !!t });
  });
  app.get('/protected', requireToken, (c) => {
    const t = getToken(c);
    return c.json({ id: t.id, scopes: t.scopes });
  });
  app.get('/scoped', requireToken, requireScope('documents:write'), (c) => c.json({ ok: true }));
  app.get('/config', requireToken, requireScope('config:write'), (c) => c.json({ ok: true }));
  app.get('/delete', requireToken, requireScope('documents:delete'), (c) => c.json({ ok: true }));
  return app;
}

test('attachToken makes the route work without a token', async () => {
  const app = build();
  const res = await app.request('/optional');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ has: false });
});

test('attachToken loads the token row when a valid Bearer header is provided', async () => {
  const { seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  const id = nanoid();
  await db.insert(apiTokens).values({
    id, workspaceId: seed.workspace.id, name: 'test', tokenHash: hash,
    scopes: ['documents:read'], createdBy: seed.user.id,
  });
  const app = build();
  const res = await app.request('/protected', { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ id, scopes: ['documents:read'] });
});

test('requireToken returns 401 when no Bearer header is provided', async () => {
  const app = build();
  const res = await app.request('/protected');
  expect(res.status).toBe(401);
});

test('requireToken returns 401 when the Bearer token does not match any row', async () => {
  const app = build();
  const res = await app.request('/protected', { headers: { Authorization: 'Bearer folio_pat_doesnotexist' } });
  expect(res.status).toBe(401);
});

test('requireScope returns 403 when the token lacks the required scope', async () => {
  const { seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(), workspaceId: seed.workspace.id, name: 'test', tokenHash: hash,
    scopes: ['documents:read'], createdBy: seed.user.id,
  });
  const app = build();
  const res = await app.request('/scoped', { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.error.code).toBe('FORBIDDEN_SCOPE');
});

test('requireScope passes when the token has the required scope', async () => {
  const { seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(), workspaceId: seed.workspace.id, name: 'test', tokenHash: hash,
    scopes: ['documents:write'], createdBy: seed.user.id,
  });
  const app = build();
  const res = await app.request('/scoped', { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
});

// --- config:write legacy-alias grandfathering (OP2-F1) -------------------
// Phase 2 consolidated four granular config scopes into one canonical
// config:write. Tokens minted before that carry the legacy granular scopes;
// requireScope('config:write') must still accept them so existing PATs keep
// working without an upgrade path.

test('requireScope(config:write) passes a token holding a legacy granular scope', async () => {
  const { seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(), workspaceId: seed.workspace.id, name: 'legacy', tokenHash: hash,
    scopes: ['fields:write'], createdBy: seed.user.id,
  });
  const app = build();
  const res = await app.request('/config', { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
});

test('requireScope(config:write) passes a token holding config:write directly', async () => {
  const { seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(), workspaceId: seed.workspace.id, name: 'modern', tokenHash: hash,
    scopes: ['config:write'], createdBy: seed.user.id,
  });
  const app = build();
  const res = await app.request('/config', { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
});

test('requireScope(config:write) rejects a token with only documents:read', async () => {
  const { seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(), workspaceId: seed.workspace.id, name: 'reader', tokenHash: hash,
    scopes: ['documents:read'], createdBy: seed.user.id,
  });
  const app = build();
  const res = await app.request('/config', { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(403);
  expect((await res.json()).error.code).toBe('FORBIDDEN_SCOPE');
});

test('the config:write alias does NOT leak to other scopes (fields:write !=> documents:delete)', async () => {
  const { seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(), workspaceId: seed.workspace.id, name: 'legacy', tokenHash: hash,
    scopes: ['fields:write'], createdBy: seed.user.id,
  });
  const app = build();
  const res = await app.request('/delete', { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(403);
});

// --- token expiry enforcement (hardening 1.2, mitigations 1-2) ------------
// expiresAt is enforced at the ONE bearer convergence point (attachToken,
// invariant 1). An expired token must STOP authorizing and must be
// INDISTINGUISHABLE from an unknown token (no expired-vs-unknown oracle).

test('an expired token (expiresAt in the past) is rejected with 401', async () => {
  const { seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(), workspaceId: seed.workspace.id, name: 'expired', tokenHash: hash,
    scopes: ['documents:read'], createdBy: seed.user.id,
    expiresAt: new Date(Date.now() - 60_000), // expired one minute ago
  });
  const app = build();
  const res = await app.request('/protected', { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(401);
});

test('an expired token and an unknown token return the SAME status (no oracle)', async () => {
  const { seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(), workspaceId: seed.workspace.id, name: 'expired', tokenHash: hash,
    scopes: ['documents:read'], createdBy: seed.user.id,
    expiresAt: new Date(Date.now() - 1000),
  });
  const app = build();
  const expiredRes = await app.request('/protected', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const unknownRes = await app.request('/protected', {
    headers: { Authorization: 'Bearer folio_pat_doesnotexist' },
  });
  expect(expiredRes.status).toBe(unknownRes.status);
  // Bodies must also match shape — same 401 error code, no "expired" leak.
  expect(await expiredRes.json()).toEqual(await unknownRes.json());
});

test('a token with expiresAt in the FUTURE still authorizes (no over-blocking)', async () => {
  const { seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  const id = nanoid();
  await db.insert(apiTokens).values({
    id, workspaceId: seed.workspace.id, name: 'future', tokenHash: hash,
    scopes: ['documents:read'], createdBy: seed.user.id,
    expiresAt: new Date(Date.now() + 60 * 60_000), // expires in an hour
  });
  const app = build();
  const res = await app.request('/protected', { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ id, scopes: ['documents:read'] });
});

// --- coarse last_used_at bump (hardening 1.2, mitigation 4) ---------------
// The lastUsedAt bump fired on EVERY request (a write-per-request
// amplification). It is now guarded: only fire when lastUsedAt is null or
// older than 60s. The bump is fire-and-forget, so we await a small delay
// before re-reading.

async function readLastUsedAt(id: string): Promise<Date | null> {
  const row = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, id) });
  return row?.lastUsedAt ?? null;
}

test('last_used_at is NOT re-written within the 60s window', async () => {
  const { seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  const id = nanoid();
  const recent = new Date(Date.now() - 5_000); // used 5s ago — inside the window
  await db.insert(apiTokens).values({
    id, workspaceId: seed.workspace.id, name: 'recent', tokenHash: hash,
    scopes: ['documents:read'], createdBy: seed.user.id,
    lastUsedAt: recent,
  });
  const app = build();
  const res = await app.request('/protected', { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  await new Promise((r) => setTimeout(r, 50)); // let the fire-and-forget settle
  const after = await readLastUsedAt(id);
  expect(after?.getTime()).toBe(recent.getTime()); // unchanged
});

test('last_used_at IS updated when it is null (or older than 60s)', async () => {
  const { seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  const id = nanoid();
  await db.insert(apiTokens).values({
    id, workspaceId: seed.workspace.id, name: 'nullused', tokenHash: hash,
    scopes: ['documents:read'], createdBy: seed.user.id,
    lastUsedAt: null,
  });
  const before = Date.now();
  const app = build();
  const res = await app.request('/protected', { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  await new Promise((r) => setTimeout(r, 50));
  const after = await readLastUsedAt(id);
  expect(after).not.toBeNull();
  expect(after!.getTime()).toBeGreaterThanOrEqual(before);
});

// --- operator unaffected (mitigation 3, structural) -----------------------
// The operator's in-memory EphemeralToken is minted in services/
// conversation-runs.ts and NEVER flows through attachToken's DB lookup, so
// the expiry gate (which keys on the DB `row`) cannot touch it. The
// `isOperator` marker is un-forgeable: it is not an api_tokens column, so it
// can never survive a DB round-trip (proven in lib/folio-api-tool.test.ts —
// "the isOperator marker can NEVER survive a DB round-trip"). This test
// asserts the structural fact directly: a row persisted with isOperator set
// reloads WITHOUT it, so attachToken can never resolve an operator token.
test('expiry gate cannot touch the operator: isOperator never survives a DB round-trip', async () => {
  const { seed } = await makeTestApp();
  const { hash } = newApiToken();
  const id = nanoid();
  await db.insert(apiTokens).values({
    id, workspaceId: seed.workspace.id, name: 'op-shaped', tokenHash: hash,
    scopes: ['documents:read'], createdBy: seed.user.id,
    isOperator: true, // not a column — silently dropped by the persistence layer
  } as never);
  const reloaded = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, id) });
  expect(reloaded).toBeTruthy();
  expect('isOperator' in (reloaded as object)).toBe(false);
});
