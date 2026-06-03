import { test, expect } from 'bun:test';
import { Hono } from 'hono';
import { makeTestApp } from '../test/harness.ts';
import { registerErrorHandler } from '../lib/http.ts';
import { requireUser, attachUser, type AuthContext } from './auth.ts';
import { attachToken } from './bearer.ts';
import { newApiToken } from '../lib/auth.ts';
import {
  resolveWorkspace,
  resolveProject,
  resolveTable,
  getWorkspace,
  getProject,
  getRole,
  getTable,
  type ScopeContext,
} from './scope.ts';

test('resolveWorkspace 404 on unknown slug', async () => {
  const { seed } = await makeTestApp();
  const app = new Hono<AuthContext & ScopeContext>();
  registerErrorHandler(app);
  app.use('/:wslug', attachUser, requireUser, resolveWorkspace);
  app.get('/:wslug', (c) => c.json({ ok: true }));
  const res = await app.request('/nope', { headers: { Cookie: seed.sessionCookie } });
  expect(res.status).toBe(404);
});

test('resolveWorkspace 403 when not member', async () => {
  const { db, seed } = await makeTestApp();
  const { workspaces } = await import('../db/schema.ts');
  const { nanoid } = await import('nanoid');
  await db.insert(workspaces).values({ id: nanoid(), slug: 'other', name: 'Other' });
  const app = new Hono<AuthContext & ScopeContext>();
  registerErrorHandler(app);
  app.use('/:wslug', attachUser, requireUser, resolveWorkspace);
  app.get('/:wslug', (c) => c.json({ ok: true }));
  const res = await app.request('/other', { headers: { Cookie: seed.sessionCookie } });
  expect(res.status).toBe(403);
});

test('resolveWorkspace attaches workspace + role', async () => {
  const { seed } = await makeTestApp();
  const app = new Hono<AuthContext & ScopeContext>();
  registerErrorHandler(app);
  app.use('/:wslug', attachUser, requireUser, resolveWorkspace);
  app.get('/:wslug', (c) => c.json({ name: getWorkspace(c).name, role: getRole(c) }));
  const res = await app.request('/acme', { headers: { Cookie: seed.sessionCookie } });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ name: 'Acme', role: 'owner' });
});

test('instance token (workspaceId null) passes resolveWorkspace for a non-member workspace', async () => {
  const { db, seed } = await makeTestApp();
  const { workspaces, apiTokens } = await import('../db/schema.ts');
  const { nanoid } = await import('nanoid');
  // Workspace B 'beta', no membership for seed.user (who is owner of 'acme').
  await db.insert(workspaces).values({ id: nanoid(), slug: 'beta', name: 'Beta' });
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: null,
    name: 'inst',
    tokenHash: hash,
    scopes: ['documents:read'],
    createdBy: seed.user.id,
  });
  const app = new Hono<AuthContext & ScopeContext>();
  registerErrorHandler(app);
  app.use('/:wslug', attachUser, attachToken, resolveWorkspace);
  app.get('/:wslug', (c) => c.json({ name: getWorkspace(c).name, role: getRole(c) }));
  const res = await app.request('/beta', { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ name: 'Beta', role: 'owner' });
});

test('instance token pinned token still 403 on a non-matching workspace (TM1)', async () => {
  const { db, seed } = await makeTestApp();
  const { workspaces, apiTokens } = await import('../db/schema.ts');
  const { nanoid } = await import('nanoid');
  await db.insert(workspaces).values({ id: nanoid(), slug: 'beta', name: 'Beta' });
  const { token, hash } = newApiToken();
  // Pinned to 'acme'.
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: seed.workspace.id,
    name: 'pinned',
    tokenHash: hash,
    scopes: ['documents:read'],
    createdBy: seed.user.id,
  });
  const app = new Hono<AuthContext & ScopeContext>();
  registerErrorHandler(app);
  app.use('/:wslug', attachUser, attachToken, resolveWorkspace);
  app.get('/:wslug', (c) => c.json({ ok: true }));
  const res = await app.request('/beta', { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(403);
  expect((await res.json()).error.message).toBe('token does not belong to this workspace');
});

test('instance token with no resolvable user still 401 (TM2)', async () => {
  const { db } = await makeTestApp();
  const { apiTokens } = await import('../db/schema.ts');
  const { nanoid } = await import('nanoid');
  const { token, hash } = newApiToken();
  // createdBy null → attachToken cannot hydrate a user. No session cookie.
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId: null,
    name: 'inst-nouser',
    tokenHash: hash,
    scopes: ['documents:read'],
    createdBy: null,
  });
  const app = new Hono<AuthContext & ScopeContext>();
  registerErrorHandler(app);
  app.use('/:wslug', attachUser, attachToken, resolveWorkspace);
  app.get('/:wslug', (c) => c.json({ ok: true }));
  const res = await app.request('/acme', { headers: { Authorization: `Bearer ${token}` } });
  expect(res.status).toBe(401);
  expect((await res.json()).error.message).toBe('login required');
});

test('resolveProject loads project scoped to workspace', async () => {
  const { seed } = await makeTestApp();
  const app = new Hono<AuthContext & ScopeContext>();
  registerErrorHandler(app);
  app.use('/:wslug/p/:pslug/*', attachUser, requireUser, resolveWorkspace, resolveProject);
  app.get('/:wslug/p/:pslug', (c) => c.json({ slug: getProject(c).slug }));
  const res = await app.request('/acme/p/web', { headers: { Cookie: seed.sessionCookie } });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ slug: 'web' });
});

test('resolveTable attaches table to context when slug exists in project', async () => {
  const { seed } = await makeTestApp({ seedProjectDefaults: true });
  const app = new Hono<AuthContext & ScopeContext>();
  registerErrorHandler(app);
  app.use('/:wslug/p/:pslug/t/:tslug/*', attachUser, requireUser, resolveWorkspace, resolveProject, resolveTable);
  app.get('/:wslug/p/:pslug/t/:tslug', (c) => c.json({ tableName: getTable(c).name, tableSlug: getTable(c).slug }));
  const res = await app.request('/acme/p/web/t/work-items', { headers: { Cookie: seed.sessionCookie } });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ tableName: 'Work Items', tableSlug: 'work-items' });
});

test('resolveTable 404 on unknown slug', async () => {
  const { seed } = await makeTestApp();
  const app = new Hono<AuthContext & ScopeContext>();
  registerErrorHandler(app);
  app.use('/:wslug/p/:pslug/t/:tslug/*', attachUser, requireUser, resolveWorkspace, resolveProject, resolveTable);
  app.get('/:wslug/p/:pslug/t/:tslug', (c) => c.json({ ok: true }));
  const res = await app.request('/acme/p/web/t/nope', { headers: { Cookie: seed.sessionCookie } });
  expect(res.status).toBe(404);
  const body = await res.json();
  expect(body.error.code).toBe('TABLE_NOT_FOUND');
});

test('resolveProject auto-attaches the default Work Items table for legacy paths', async () => {
  const { seed } = await makeTestApp({ seedProjectDefaults: true });
  const app = new Hono<AuthContext & ScopeContext>();
  registerErrorHandler(app);
  app.use('/:wslug/p/:pslug/*', attachUser, requireUser, resolveWorkspace, resolveProject);
  app.get('/:wslug/p/:pslug/probe', (c) => c.json({ tableSlug: getTable(c).slug }));
  const res = await app.request('/acme/p/web/probe', { headers: { Cookie: seed.sessionCookie } });
  expect(res.status).toBe(200);
  expect((await res.json()).tableSlug).toBe('work-items');
});

test('resolveProject does not attach a table for projects without one', async () => {
  const { seed } = await makeTestApp({ seedProjectDefaults: false });
  const app = new Hono<AuthContext & ScopeContext>();
  registerErrorHandler(app);
  app.use('/:wslug/p/:pslug/*', attachUser, requireUser, resolveWorkspace, resolveProject);
  app.get('/:wslug/p/:pslug/probe', (c) => c.json({ hasTable: c.get('table') != null }));
  const res = await app.request('/acme/p/web/probe', { headers: { Cookie: seed.sessionCookie } });
  expect(res.status).toBe(200);
  expect((await res.json()).hasTable).toBe(false);
});
