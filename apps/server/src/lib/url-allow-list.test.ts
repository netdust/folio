import { describe, expect, test } from 'bun:test';
import { validatePublicUrl } from './url-allow-list.ts';

describe('validatePublicUrl', () => {
  test('allows a public https URL', () => {
    expect(validatePublicUrl('https://ollama.example.com')).toEqual({ ok: true });
  });

  test('blocks loopback IPv4 (127.0.0.1)', () => {
    const r = validatePublicUrl('http://127.0.0.1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/loopback|private/i);
  });

  test('blocks private IPv4 10.0.0.5', () => {
    const r = validatePublicUrl('http://10.0.0.5');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/private|loopback/i);
  });

  test('blocks private IPv4 192.168.1.1', () => {
    const r = validatePublicUrl('http://192.168.1.1');
    expect(r.ok).toBe(false);
  });

  test('blocks private IPv4 172.20.0.5 (in 172.16-31 range)', () => {
    const r = validatePublicUrl('http://172.20.0.5');
    expect(r.ok).toBe(false);
  });

  test('allows 172.32.0.5 (outside 172.16-31)', () => {
    const r = validatePublicUrl('http://172.32.0.5');
    expect(r.ok).toBe(true);
  });

  test('blocks link-local 169.254.169.254 (AWS metadata)', () => {
    const r = validatePublicUrl('http://169.254.169.254/');
    expect(r.ok).toBe(false);
  });

  test('blocks "localhost"', () => {
    const r = validatePublicUrl('http://localhost:11434');
    expect(r.ok).toBe(false);
  });

  test('blocks "foo.localhost"', () => {
    const r = validatePublicUrl('http://foo.localhost');
    expect(r.ok).toBe(false);
  });

  test('blocks non-http scheme (file://)', () => {
    const r = validatePublicUrl('file:///etc/passwd');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/scheme/i);
  });

  test('blocks IPv6 loopback [::1]', () => {
    const r = validatePublicUrl('http://[::1]');
    expect(r.ok).toBe(false);
  });

  test('blocks invalid URL string', () => {
    const r = validatePublicUrl('not a url');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/valid URL/i);
  });

  // Fix #1 — IPv4-mapped IPv6. Linux routes ::ffff:* to the underlying IPv4,
  // so any of these forms reaches the same target as the dotted IPv4 would.
  // Bun's URL parser canonicalizes [::ffff:127.0.0.1] to host ::ffff:7f00:1.
  test('blocks IPv4-mapped IPv6 loopback [::ffff:127.0.0.1]', () => {
    const r = validatePublicUrl('http://[::ffff:127.0.0.1]/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/private|loopback|mapped/i);
  });

  test('blocks IPv4-mapped IPv6 private 10/8 [::ffff:10.0.0.5]', () => {
    const r = validatePublicUrl('http://[::ffff:10.0.0.5]/');
    expect(r.ok).toBe(false);
  });

  test('blocks IPv4-mapped IPv6 private 192.168/16 [::ffff:192.168.1.1]', () => {
    const r = validatePublicUrl('http://[::ffff:192.168.1.1]/');
    expect(r.ok).toBe(false);
  });

  test('blocks IPv4-mapped IPv6 link-local AWS metadata [::ffff:169.254.169.254]', () => {
    const r = validatePublicUrl('http://[::ffff:169.254.169.254]/');
    expect(r.ok).toBe(false);
  });

  test('allows IPv4-mapped IPv6 pointing at a public IPv4 [::ffff:8.8.8.8]', () => {
    const r = validatePublicUrl('http://[::ffff:8.8.8.8]/');
    expect(r.ok).toBe(true);
  });

  // B round 3 fix #4 — trailing-dot localhost (root-anchored DNS form). Linux
  // resolves localhost. to 127.0.0.1; round 2 missed the trailing dot in the
  // equality check.
  test('blocks trailing-dot localhost (root-anchored DNS form)', () => {
    expect(validatePublicUrl('http://localhost.:11434').ok).toBe(false);
  });

  test('blocks "foo.localhost." (trailing-dot suffix form)', () => {
    expect(validatePublicUrl('http://foo.localhost.:11434').ok).toBe(false);
  });

  // B round 3 fix #5 — expanded IPv4-mapped IPv6 form. Bun's URL parser
  // canonicalizes 0:0:0:0:0:ffff:hhhh:hhhh to the 2-segment shape ::ffff:..
  // already (verified via `bun --eval`), so the existing path catches these.
  // We add the expanded regex as defense-in-depth against any future runtime
  // / proxy that does NOT canonicalize.
  test('blocks expanded IPv4-mapped IPv6 (0:0:0:0:0:ffff:7f00:1 → 127.0.0.1)', () => {
    const r = validatePublicUrl('http://[0:0:0:0:0:ffff:7f00:1]/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/private|loopback|mapped/i);
  });

  test('blocks expanded IPv4-mapped IPv6 reaching AWS metadata', () => {
    const r = validatePublicUrl('http://[0:0:0:0:0:ffff:a9fe:a9fe]/');
    expect(r.ok).toBe(false);
  });

  // B round 4 fix #3 — greedy trailing-dot strip. Pre-fix `slice(0, -1)` only
  // stripped one dot, so `localhost..` survived as `localhost.` and slipped
  // the equality check. Linux resolves any-trailing-dots form to the same
  // address. `.replace(/\.+$/, '')` matches that behavior.
  test('blocks multi-dot trailing-localhost (greedy strip — two dots)', () => {
    expect(validatePublicUrl('http://localhost..:11434').ok).toBe(false);
  });

  test('blocks multi-dot trailing-localhost (greedy strip — three dots)', () => {
    expect(validatePublicUrl('http://localhost...:11434').ok).toBe(false);
  });

  test('blocks multi-dot trailing foo.localhost (greedy strip — suffix)', () => {
    expect(validatePublicUrl('http://foo.localhost..:11434').ok).toBe(false);
  });

  // B round 4 fix #4 — expanded-form pure IPv6 loopback + unspecified.
  // Round 3 only added the IPv4-mapped expanded form; ::1 and :: were left
  // exact-match. Bun's URL parser canonicalizes both today, but the bracket
  // form `[0:0:0:0:0:0:0:1]` arrives as a literal IPv6 string that the parser
  // may or may not compress depending on runtime. Defense in depth.
  test('blocks expanded IPv6 loopback (0:0:0:0:0:0:0:1)', () => {
    const r = validatePublicUrl('http://[0:0:0:0:0:0:0:1]/');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/private|loopback/i);
  });

  test('blocks expanded IPv6 unspecified (0:0:0:0:0:0:0:0)', () => {
    const r = validatePublicUrl('http://[0:0:0:0:0:0:0:0]/');
    expect(r.ok).toBe(false);
  });

  // B round 5 #7 — bare-dot inputs parse successfully in Bun's URL parser
  // (the parser interprets the trailing dot as a root-anchored DNS form and
  // accepts the host) but become empty strings after the greedy trailing-dot
  // strip. Pre-fix the empty string slipped every host-equality + prefix
  // regex and returned ok:true. Threat mitigation 18.
  test('blocks bare-dot host (http://./)', () => {
    const r = validatePublicUrl('http://./');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/empty|host/i);
  });

  test('blocks multiple-dot host (http://.../)', () => {
    const r = validatePublicUrl('http://.../');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/empty|host/i);
  });
});
