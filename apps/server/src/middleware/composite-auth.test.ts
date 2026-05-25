import { test, expect } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { apiTokens } from '../db/schema.ts';
import { newApiToken } from '../lib/auth.ts';
import { makeTestApp } from '../test/harness.ts';
import { nanoid } from 'nanoid';

test('documents GET works with a session cookie (existing behavior)', async () => {
  const { app, seed } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/p/web/documents', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
});

test('documents GET works with a Bearer token that has documents:read', async () => {
  const { app, seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(), workspaceId: seed.workspace.id, name: 'test', tokenHash: hash,
    scopes: ['documents:read'], createdBy: seed.user.id,
  });
  const res = await app.request('/api/v1/w/acme/p/web/documents', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
});

test('documents POST requires documents:write scope', async () => {
  const { app, seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(), workspaceId: seed.workspace.id, name: 'test', tokenHash: hash,
    scopes: ['documents:read'], createdBy: seed.user.id,
  });
  const res = await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'From token' }),
  });
  expect(res.status).toBe(403);
});

test('documents POST works with documents:write scope', async () => {
  const { app, seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(), workspaceId: seed.workspace.id, name: 'test', tokenHash: hash,
    scopes: ['documents:write'], createdBy: seed.user.id,
  });
  const res = await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'From token' }),
  });
  expect(res.status).toBe(201);
});

test('documents POST without any auth returns 401', async () => {
  const { app } = await makeTestApp();
  const res = await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'No auth' }),
  });
  expect(res.status).toBe(401);
});

test('a revoked token immediately blocks subsequent requests', async () => {
  const { app, seed } = await makeTestApp();
  const { token, hash } = newApiToken();
  const id = nanoid();
  await db.insert(apiTokens).values({
    id, workspaceId: seed.workspace.id, name: 'test', tokenHash: hash,
    scopes: ['documents:read'], createdBy: seed.user.id,
  });
  const ok = await app.request('/api/v1/w/acme/p/web/documents', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(ok.status).toBe(200);
  await db.delete(apiTokens).where(eq(apiTokens.id, id));
  const blocked = await app.request('/api/v1/w/acme/p/web/documents', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(blocked.status).toBe(401);
});
