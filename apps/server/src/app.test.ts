/**
 * M1 (audit M10): global request-body cap.
 *
 * A caller (authed user or agent token) must not be able to POST a
 * multi-hundred-MB body and exhaust memory before any route's Zod validation
 * runs. The `hono/body-limit` middleware is registered app-wide; an oversized
 * POST is rejected with 413 BEFORE the handler buffers it, and the rejection
 * rides the standard `{error:{code,message}}` envelope (invariant 9 / SA-2).
 *
 * Tier A — a boundary guard with a denial path. The 413 (denial) is the
 * contract; the normal-body pass-through is the boundary case proving the cap
 * does not over-reject.
 */
import { describe, expect, it } from 'bun:test';
import { makeTestApp } from './test/harness.ts';

describe('global request-body limit', () => {
  it('rejects an oversized POST body with 413 and the standard envelope', async () => {
    const { app } = await makeTestApp();

    // 6 MB > the 5 MB default cap.
    const oversized = 'x'.repeat(6 * 1024 * 1024);
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: oversized,
    });

    expect(res.status).toBe(413);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(typeof json.error.message).toBe('string');
  });

  it('lets a normal-size body through (not 413)', async () => {
    const { app } = await makeTestApp();

    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@test.local', password: 'wrong-password' }),
    });

    // The cap must NOT trip on a normal body — the handler is reached and
    // returns its own status (401/400). The only forbidden outcome is 413.
    expect(res.status).not.toBe(413);
  });
});
