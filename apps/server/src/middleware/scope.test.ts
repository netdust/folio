import { test, expect } from 'bun:test';
import { Hono } from 'hono';
import { makeTestApp } from '../test/harness.ts';
import { registerErrorHandler } from '../lib/http.ts';
import { requireUser, attachUser, type AuthContext } from './auth.ts';
import {
  resolveWorkspace,
  resolveProject,
  getWorkspace,
  getProject,
  getRole,
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
