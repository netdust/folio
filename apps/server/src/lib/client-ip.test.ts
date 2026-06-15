import { describe, expect, test } from 'bun:test';
import type { Context } from 'hono';
import { clientIp } from './client-ip.ts';

// CR-C1 / audit B2: the SINGLE source of the client IP (SA-4). Only the
// x-forwarded-for first-hop was exercised before (indirectly, via the throttle
// tests). These pin the x-real-ip fallback and the no-header 'unknown' sentinel
// so a regression in either degraded path goes RED.

function ctx(headers: Record<string, string>): Context {
  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
    },
  } as unknown as Context;
}

describe('clientIp', () => {
  test('takes the FIRST hop of x-forwarded-for', () => {
    expect(clientIp(ctx({ 'x-forwarded-for': '1.2.3.4, proxy1, proxy2' }))).toBe('1.2.3.4');
  });

  test('falls back to x-real-ip when x-forwarded-for is absent', () => {
    expect(clientIp(ctx({ 'x-real-ip': '9.9.9.9' }))).toBe('9.9.9.9');
  });

  test("returns 'unknown' when no IP header is present", () => {
    expect(clientIp(ctx({}))).toBe('unknown');
  });
});
