import { describe, expect, test } from 'bun:test';
import { classifyRisk, validateApiPath } from './folio-api-tool.ts';

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

describe('classifyRisk (P3-7, v1 resource-type proxy)', () => {
  test('document writes are low', () => {
    expect(classifyRisk('POST', '/api/v1/w/a/p/b/documents', {})).toBe('low');
  });
  test('config writes (tables/fields/views/statuses/projects) are medium', () => {
    expect(classifyRisk('POST', '/api/v1/w/a/p/b/tables', {})).toBe('medium');
    expect(classifyRisk('DELETE', '/api/v1/w/a/p/b/views/v1', {})).toBe('medium');
  });
  test('membership/role + workspace delete + explicit bulk are high', () => {
    expect(classifyRisk('DELETE', '/api/v1/w/a', {})).toBe('high'); // workspace delete
    expect(classifyRisk('POST', '/api/v1/w/a/members', {})).toBe('high'); // future
    expect(classifyRisk('PATCH', '/api/v1/w/a/p/b/documents', { bulk: true })).toBe('high');
  });

  // Pin tests (P3-7): the project-config rule must NOT swallow document/comment/run
  // sub-resources mounted under /p/:slug. Document writes stay low; the projects
  // COLLECTION and the project ITEM route are the only project-config medium paths.
  test('document write under a project is low, project create/rename are medium', () => {
    expect(classifyRisk('POST', '/api/v1/w/a/p/b/documents', {})).toBe('low'); // sub-resource
    expect(classifyRisk('POST', '/api/v1/w/a/p/b/comments', {})).toBe('low'); // sub-resource
    expect(classifyRisk('GET', '/api/v1/w/a/p/b/runs', {})).toBe('low'); // read, sub-resource
    expect(classifyRisk('POST', '/api/v1/w/a/projects', {})).toBe('medium'); // create project
    expect(classifyRisk('PATCH', '/api/v1/w/a/projects/b', {})).toBe('medium'); // rename project
    expect(classifyRisk('DELETE', '/api/v1/w/a/projects/b', {})).toBe('medium'); // delete project
    // Plan's spec example also pins the bare project-item form as medium:
    expect(classifyRisk('PATCH', '/api/v1/w/a/p/b', {})).toBe('medium'); // project item (no sub-resource)
  });

  test('token mint/revoke routes are high (P3-7 hardening)', () => {
    expect(classifyRisk('POST', '/api/v1/w/a/tokens', {})).toBe('high');
    expect(classifyRisk('DELETE', '/api/v1/w/a/tokens/tok1', {})).toBe('high');
    expect(classifyRisk('GET', '/api/v1/w/a/tokens', {})).not.toBe('high'); // read doesn't gate
  });
  test('BYOK key / settings writes are high (P3-7 hardening)', () => {
    expect(classifyRisk('POST', '/api/v1/w/a/settings/ws1/ai-keys', {})).toBe('high');
    expect(classifyRisk('DELETE', '/api/v1/w/a/settings/ws1/ai-keys/k1', {})).toBe('high');
  });
  test('workspace rename + delete are high; project sub-resources unaffected', () => {
    expect(classifyRisk('PATCH', '/api/v1/w/a', {})).toBe('high'); // rename
    expect(classifyRisk('DELETE', '/api/v1/w/a', {})).toBe('high'); // delete
    expect(classifyRisk('POST', '/api/v1/w/a/p/b/documents', {})).toBe('low'); // regression guard
  });
  test('method case is normalized', () => {
    expect(classifyRisk('delete', '/api/v1/w/a', {})).toBe('high');
  });
  test('members read does not classify high (symmetry)', () => {
    expect(classifyRisk('GET', '/api/v1/w/a/members', {})).not.toBe('high');
  });
});
