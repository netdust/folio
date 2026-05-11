import { test, expect } from 'bun:test';
import { makeTestApp } from './harness.ts';

test('makeTestApp returns a working app + seeded data', async () => {
  const { app, seed } = await makeTestApp();
  expect(seed.user.email).toBe('alice@test.local');
  expect(seed.workspace.slug).toBe('acme');
  expect(seed.project.slug).toBe('web');
  expect(seed.sessionCookie).toMatch(/^folio_session=/);

  const res = await app.request('/api/auth/me', {
    headers: { Cookie: seed.sessionCookie },
  });
  expect(res.status).toBe(200);
});
