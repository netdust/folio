import type { Context } from 'hono';

/**
 * The SINGLE source of the client IP (SA-4). Every rate-limit key derives its IP
 * dimension from here — no inline `x-forwarded-for` / `x-real-ip` reads anywhere
 * else, so the trusted-proxy assumption is decided in exactly one place.
 *
 * TRUSTED-PROXY ASSUMPTION: a production Folio sits behind a reverse proxy
 * (Ploi/nginx) that OVERWRITES `x-forwarded-for` with the real peer address. We
 * therefore trust the FIRST hop of `x-forwarded-for`. On a direct-to-Bun deploy
 * with no proxy these headers are client-controllable and the IP dimension is
 * spoofable — but the throttle still degrades safely: the email-keyed counter
 * (independent of IP) remains effective, and the proxy is the documented,
 * supported deployment (docs/INSTALL.md). Do NOT trust this header for anything
 * stronger than rate-limiting.
 */
export function clientIp(c: Context): string {
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) {
    // `x-forwarded-for: client, proxy1, proxy2` — the first hop is the client.
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = c.req.header('x-real-ip')?.trim();
  if (real) return real;
  return 'unknown';
}
