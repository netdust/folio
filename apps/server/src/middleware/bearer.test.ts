import { test, expect } from 'bun:test';
import { Hono } from 'hono';
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
