/**
 * Invariant 17 regression — root-of-trust stays session-only (mitigation 5).
 *
 * The D1 loosening (headless-Folio Phase 1) opens AGENT LIFECYCLE to admin PATs.
 * It must NOT have widened the root-of-trust class: minting any token (instance
 * OR per-workspace), writing an AI/BYOK key, and changing an instance role stay
 * reachable ONLY via a logged-in session (`requireSessionUser`), never via a
 * bearer token — even an owner/admin PAT carrying every scope.
 *
 * These mounts are `requireSessionUser`; a Bearer never populates `c.get('user')`
 * (attachToken runs, attachUser does not on these mounts), so the guard returns
 * 401/403 before any handler. This test pins that an admin PAT — the most
 * powerful bearer D1 admits to agent CRUD — is STILL rejected on each
 * root-of-trust route.
 *
 * Account creation (`POST /auth/register`) is in the root-of-trust class too, but
 * it is gated DIFFERENTLY — by the bootstrap flag / first-user rule, not by a
 * session — so it is asserted separately below (a bearer does not bypass the
 * first-user/bootstrap gate either).
 */
import { expect, test } from 'bun:test';
import { db } from '../db/client.ts';
import { makeTestApp, mintInstancePat } from '../test/harness.ts';

/**
 * Mint an INSTANCE-reach admin PAT (full owner/admin scope set) and return its
 * plaintext bearer. Wraps the shared `mintInstancePat` harness helper so the
 * instance-PAT seeding shape lives in one place.
 */
async function mintAdminPat(userId: string): Promise<string> {
  const { token } = await mintInstancePat(db, userId);
  return token;
}

test('an admin PAT is rejected on all session-only root-of-trust routes (invariant 17)', async () => {
  const { app, seed } = await makeTestApp();
  const adminPat = await mintAdminPat(seed.user.id);
  const auth = { Authorization: `Bearer ${adminPat}`, 'content-type': 'application/json' };

  const probes: Array<{ method: string; path: string; body?: unknown }> = [
    // Mint an instance token.
    { method: 'POST', path: '/api/v1/instance/tokens', body: { name: 'x', scopes: ['documents:read'] } },
    // Mint a per-workspace token.
    {
      method: 'POST',
      path: `/api/v1/w/${seed.workspace.slug}/tokens/${seed.workspace.id}`,
      body: { name: 'x', scopes: ['documents:read'] },
    },
    // Write an AI/BYOK key (secret-class). (`requireSessionUser` is `.use('*')`
    // middleware that fires BEFORE the body validator, so the bearer is rejected
    // regardless of body shape — a realistic body is used for clarity.)
    {
      method: 'POST',
      path: '/api/v1/instance/ai-keys',
      body: { provider: 'anthropic', apiKey: 'sk-test-xxxxxxxx', label: 'default' },
    },
    // Promote an instance role (owner-only, session-only).
    { method: 'PATCH', path: `/api/v1/instance/users/${seed.user.id}/role`, body: { role: 'owner' } },
  ];

  for (const { method, path, body } of probes) {
    const res = await app.request(path, {
      method,
      headers: auth,
      body: body ? JSON.stringify(body) : undefined,
    });
    expect(
      [401, 403],
      `expected ${method} ${path} to reject the admin PAT with 401/403, got ${res.status}`,
    ).toContain(res.status);
  }
});

test('account creation (register) confers no extra power on an admin PAT bearer', async () => {
  // register is gated by the first-user/bootstrap rule, NOT a session — so the
  // root-of-trust property here is INVARIANCE: register behaves identically with
  // and without an admin bearer. The bearer must unlock nothing. We assert the
  // status is the same whether or not the Authorization header is present
  // (whatever the env's registration policy is), so an admin PAT cannot turn a
  // closed register into an open one or vice-versa.
  const base = { email: 'rot-probe@test.local', password: 'password123', name: 'New' };

  // No bearer.
  const a = await makeTestApp();
  const noBearer = await a.app.request('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(base),
  });

  // With an admin bearer (fresh app/seed so the email isn't already taken).
  const b = await makeTestApp();
  const adminPat = await mintAdminPat(b.seed.user.id);
  const withBearer = await b.app.request('/api/v1/auth/register', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminPat}`, 'content-type': 'application/json' },
    body: JSON.stringify(base),
  });

  // Identical outcome ⇒ the bearer conferred no account-creation authority.
  expect(withBearer.status).toBe(noBearer.status);
});
