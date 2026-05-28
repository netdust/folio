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
});
