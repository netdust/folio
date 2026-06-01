import { describe, expect, test } from 'bun:test';
import { validateApiPath } from './folio-api-tool.ts';

describe('validateApiPath (P3-5)', () => {
  test('accepts a relative API path', () => {
    expect(validateApiPath('/api/v1/w/acme/p/sales/tables')).toBe('/api/v1/w/acme/p/sales/tables');
  });
  test('rejects absolute URLs / scheme', () => {
    expect(() => validateApiPath('http://169.254.169.254/')).toThrow();
    expect(() => validateApiPath('https://evil.com/api/v1/x')).toThrow();
  });
  test('rejects protocol-relative + traversal + injection chars', () => {
    expect(() => validateApiPath('//evil.com')).toThrow();
    expect(() => validateApiPath('/api/v1/../../etc/passwd')).toThrow();
    expect(() => validateApiPath('/api/v1/x@y')).toThrow();
    expect(() => validateApiPath('/api/v1/x\\y')).toThrow();
  });
  test('rejects a path not under /api/v1/', () => {
    expect(() => validateApiPath('/admin/secret')).toThrow();
    expect(() => validateApiPath('relative/no/slash')).toThrow();
  });
  test('rejects control characters and null bytes (P3-5 hardening)', () => {
    expect(() => validateApiPath('/api/v1/x\x00y')).toThrow();
    expect(() => validateApiPath('/api/v1/x\ny')).toThrow();
    expect(() => validateApiPath('/api/v1/x\ty')).toThrow();
    expect(() => validateApiPath('/api/v1/x\x7fy')).toThrow();
  });
  test('accepts percent-encoded sequences by design (router does not decode them)', () => {
    // documents the assumption in Fix 2's comment — NOT a bypass for app.request
    expect(validateApiPath('/api/v1/w/a/%2e%2e/b')).toBe('/api/v1/w/a/%2e%2e/b');
  });
});
