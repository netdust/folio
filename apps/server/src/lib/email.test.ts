import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// Tier-A test for lib/email.ts magic-link URL construction (audit 3.8). email.ts
// has no SMTP_HOST configured under test, so deliver() takes the dev-console
// fallback: it re-derives the URL from the message body via extractToken()'s
// regex, then rebuilds it with magicLinkUrl(). That fallback IS a token
// round-trip (token -> URL -> message text -> regex parse -> token -> URL), and
// it's the exact path auth depends on to surface a copy-pasteable link in dev.
// We capture the dev-console line to assert the URL is well-formed and the token
// survives byte-exact, plus the adversarial token shapes the regex can mangle.
//
// magicLinkUrl()/extractToken() are NOT exported; we drive them through the real
// public surface (sendMagicLink/sendInvite) — the un-mocked seam, not a private.
//
// NOTE: env.PUBLIC_URL is config (a local .env may set it), so we assert the URL
// against the actual env.PUBLIC_URL value rather than a hardcoded base — the
// Tier-A concern is the construction/encoding logic and token integrity, not the
// operator's configured base URL.
import { env } from '../env.ts';
import { sendInvite, sendMagicLink } from './email.ts';

// Capture every console.log line so we can read the dev-console magic-link fallback.
const logged: string[] = [];
let originalLog: typeof console.log;

beforeEach(() => {
  logged.length = 0;
  originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
});

afterEach(() => {
  console.log = originalLog;
});

// Pull the URL the dev-console fallback printed (post round-trip through extractToken).
function loggedUrl(): string {
  const line = logged.join('\n');
  const m = line.match(/(https?:\/\/\S*\/auth\/magic-link\/consume\?token=\S*)/);
  return m ? m[1]! : '';
}

describe('email magic-link URL construction', () => {
  test('sendMagicLink builds the consume URL on the configured base with the token byte-exact', async () => {
    const token = 'abc123-DEADbeef_token';
    await sendMagicLink('user@example.com', token);

    const url = loggedUrl();
    expect(url).toBe(`${env.PUBLIC_URL}/auth/magic-link/consume?token=${token}`);
    // Token survives the body->regex->rebuild round-trip un-mangled.
    expect(new URL(url).searchParams.get('token')).toBe(token);
  });

  test('sendInvite builds the same magic-link consume URL (shared mechanism)', async () => {
    const token = 'invite-token-XYZ789';
    await sendInvite('invitee@example.com', token, 'Stefan');

    const url = loggedUrl();
    expect(url).toBe(`${env.PUBLIC_URL}/auth/magic-link/consume?token=${token}`);
    expect(new URL(url).searchParams.get('token')).toBe(token);
  });

  test('the email address is NOT placed in the URL — only the token is', async () => {
    // The email is the deliver() recipient/devLabel, never a URL param. A change
    // that started leaking the address into the link would break this.
    await sendMagicLink('+tagged user@日本.example', 'plain-token');
    const url = loggedUrl();
    expect(url).toBe(`${env.PUBLIC_URL}/auth/magic-link/consume?token=plain-token`);
    expect(url).not.toContain('example.com');
    expect(url).not.toContain('日本');
  });
});

describe('email magic-link URL — adversarial / boundary tokens', () => {
  test('a base64url-shaped token (the real token alphabet) round-trips byte-exact', async () => {
    // crypto.randomBytes(...).toString('base64url') yields [A-Za-z0-9_-]; assert
    // every one of those chars survives the no-encode + regex re-extract path.
    const token = 'AZaz09-_aGVsbG8tdG9rZW4';
    await sendMagicLink('a@b.com', token);
    expect(new URL(loggedUrl()).searchParams.get('token')).toBe(token);
  });

  test('a whitespace-bearing token is TRUNCATED by the dev-console regex (real behavior)', async () => {
    // extractToken() uses /consume\?token=([^\s]+)/ — it stops at the first
    // whitespace. The URL is also un-encoded, so a space in the token is NOT
    // round-trip-safe through the dev-console fallback. We assert the ACTUAL
    // (lossy) behavior so a future change that fixes OR worsens it is caught.
    await sendMagicLink('a@b.com', 'tok with space');
    const url = loggedUrl();
    expect(url).toBe(`${env.PUBLIC_URL}/auth/magic-link/consume?token=tok`);
  });

  test('an empty token produces a consume URL with an empty token param (no crash)', async () => {
    // Boundary: sendMagicLink does not reject an empty token; it builds a URL
    // with token= empty. Auth-flow callers must supply a real token; email.ts
    // itself is non-validating. Asserting this pins the contract.
    await sendMagicLink('a@b.com', '');
    const url = loggedUrl();
    expect(url).toBe(`${env.PUBLIC_URL}/auth/magic-link/consume?token=`);
  });
});
