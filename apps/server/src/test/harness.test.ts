import { test, expect } from 'bun:test';
import { makeTestApp } from './harness.ts';

test('makeTestApp returns a working app + seeded data', async () => {
  const { app, seed } = await makeTestApp();
  expect(seed.user.email).toBe('alice@test.local');
  expect(seed.workspace.slug).toBe('acme');
  expect(seed.project.slug).toBe('web');
  expect(seed.sessionCookie).toMatch(/^folio_session=/);

  const res = await app.request('/api/v1/auth/me', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
});

test('makeTestApp gives isolated DBs across calls', async () => {
  const a = await makeTestApp();
  const b = await makeTestApp();

  // Different :memory: DBs → different generated user ids despite same seed email.
  expect(a.seed.user.id).not.toBe(b.seed.user.id);

  // Route handler in `b.app` must use `b.db`, not `a.db`. `/api/v1/auth/me`
  // resolves the session via the db proxy and returns the matching user.
  const resB = await b.app.request('/api/v1/auth/me', {
    headers: { Cookie: b.seed.sessionCookie },
  });
  expect(resB.status).toBe(200);
  const bodyB = (await resB.json()) as { data: { user: { id: string } } };
  expect(bodyB.data.user.id).toBe(b.seed.user.id);

  // And the FIRST app's session cookie must NOT resolve through DB #2 — its
  // session row lives only in DB #1.
  const crossA = await b.app.request('/api/v1/auth/me', {
    headers: { Cookie: a.seed.sessionCookie },
  });
  expect(crossA.status).toBe(401);
});
