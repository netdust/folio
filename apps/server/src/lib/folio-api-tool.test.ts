import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { apiTokens, type ApiToken } from '../db/schema.ts';
import { makeTestApp } from '../test/harness.ts';
import { executeTool } from './agent-tools.ts';
import { registerRealTools } from './agent-tools-registry.ts';
import {
  classifyRisk,
  dispatchAsCaller,
  sweepOrphanedFolioApiTokens,
  validateApiPath,
} from './folio-api-tool.ts';

// folio_api_get is registered via registerRealTools() → registerFolioApiTools().
// Idempotent-guarded, so calling at module load is safe even if a sibling test
// already triggered it.
registerRealTools();

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

function callerToken(over: Partial<ApiToken>): ApiToken {
  return {
    id: 'tok_caller',
    workspaceId: '',
    name: 'caller',
    tokenHash: 'unused',
    scopes: [],
    agentId: null,
    projectIds: null,
    createdBy: null,
    lastUsedAt: null,
    createdAt: new Date(),
    ...over,
  };
}

async function countTokens(): Promise<number> {
  return (await db.select().from(apiTokens)).length;
}

describe('dispatchAsCaller (P3-1/2/3/4)', () => {
  test('reaches the route as the caller delegate (P3-1)', async () => {
    const { seed } = await makeTestApp();
    const owner = callerToken({
      workspaceId: seed.workspace.id,
      scopes: ['config:write', 'documents:read'],
      createdBy: seed.user.id,
    });
    const res = await dispatchAsCaller(
      owner,
      'GET',
      `/api/v1/w/${seed.workspace.slug}/p/${seed.project.slug}/tables`,
      undefined,
    );
    expect(res.status).toBe(200);
  });

  test('scope ceiling: a token lacking config:write is 403 on a config:write route (P3-1)', async () => {
    const { seed } = await makeTestApp();
    // agentId:null → requireResource bypasses, isolating requireScope. scopes lack config:write.
    const member = callerToken({
      workspaceId: seed.workspace.id,
      scopes: ['documents:read', 'documents:write'],
      createdBy: seed.user.id,
      agentId: null,
    });
    const res = await dispatchAsCaller(
      member,
      'POST',
      `/api/v1/w/${seed.workspace.slug}/p/${seed.project.slug}/tables`,
      { name: 'x' },
    );
    expect(res.status).toBe(403);
  });

  test('mints then revokes — token count unchanged, even on route error (P3-3)', async () => {
    const { seed } = await makeTestApp();
    const owner = callerToken({
      workspaceId: seed.workspace.id,
      scopes: ['config:write', 'documents:read'],
      createdBy: seed.user.id,
    });
    const member = callerToken({
      workspaceId: seed.workspace.id,
      scopes: ['documents:read'],
      createdBy: seed.user.id,
      agentId: null,
    });
    const before = await countTokens();
    await dispatchAsCaller(
      owner,
      'GET',
      `/api/v1/w/${seed.workspace.slug}/p/${seed.project.slug}/tables`,
      undefined,
    );
    expect(await countTokens()).toBe(before); // success path nets zero
    await dispatchAsCaller(
      member,
      'POST',
      `/api/v1/w/${seed.workspace.slug}/p/${seed.project.slug}/tables`,
      { name: 'x' },
    ); // 403 path
    expect(await countTokens()).toBe(before); // finally still revoked
  });

  test('never serializes the minted plaintext (P3-2)', async () => {
    const { seed } = await makeTestApp();
    const owner = callerToken({
      workspaceId: seed.workspace.id,
      scopes: ['config:write', 'documents:read'],
      createdBy: seed.user.id,
    });
    const res = await dispatchAsCaller(
      owner,
      'GET',
      `/api/v1/w/${seed.workspace.slug}/p/${seed.project.slug}/tables`,
      undefined,
    );
    const text = await res.clone().text();
    expect(text).not.toMatch(/folio_pat_/);
  });

  test('minted token inherits caller config:write — POST succeeds for owner (P3-1)', async () => {
    const { seed } = await makeTestApp();
    const owner = callerToken({
      workspaceId: seed.workspace.id,
      scopes: ['config:write', 'documents:read'],
      createdBy: seed.user.id,
    });
    const res = await dispatchAsCaller(
      owner,
      'POST',
      `/api/v1/w/${seed.workspace.slug}/p/${seed.project.slug}/tables`,
      { name: 'Sprints' },
    );
    expect(res.status).toBe(201); // create table succeeded → minted token had config:write
  });
});

describe('sweepOrphanedFolioApiTokens (P3-3 backstop)', () => {
  test('deletes folio_api: tokens left live by a crash/revoke-failure', async () => {
    const { db: testDb, seed } = await makeTestApp();
    // simulate an orphan: insert a folio_api:-named token directly
    await testDb.insert(apiTokens).values({
      id: 'orphan1',
      workspaceId: seed.workspace.id,
      name: 'folio_api:orphan1',
      tokenHash: 'h',
      scopes: ['config:write'],
      agentId: null,
      projectIds: null,
      createdBy: seed.user.id,
    });
    const swept = await sweepOrphanedFolioApiTokens(testDb);
    expect(swept).toBeGreaterThanOrEqual(1);
    const remaining = await testDb
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.name, 'folio_api:orphan1'));
    expect(remaining.length).toBe(0);
  });

  test('leaves non-folio_api tokens untouched', async () => {
    const { db: testDb, seed } = await makeTestApp();
    await testDb.insert(apiTokens).values({
      id: 'pat1',
      workspaceId: seed.workspace.id,
      name: 'a human PAT',
      tokenHash: 'h2',
      scopes: ['documents:read'],
      agentId: null,
      projectIds: null,
      createdBy: seed.user.id,
    });
    await sweepOrphanedFolioApiTokens(testDb);
    const remaining = await testDb
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.id, 'pat1'));
    expect(remaining.length).toBe(1);
  });
});

describe('folio_api_get tool (P3-4/6)', () => {
  test('folio_api_get reads a route, returns parsed body (P3-6)', async () => {
    const { seed } = await makeTestApp();
    const tok = callerToken({
      workspaceId: seed.workspace.id,
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });
    const out = (await executeTool(
      tok,
      'agent:op',
      'folio_api_get',
      { path: `/api/v1/w/${seed.workspace.slug}/p/${seed.project.slug}/tables` },
      undefined,
      { callerScopes: tok.scopes },
    )) as { status: number; body: unknown };
    expect(out.status).toBe(200);
  });

  test('folio_api_get schema rejects a method field (P3-6 — GET-forced, no method)', async () => {
    const { seed } = await makeTestApp();
    const tok = callerToken({
      workspaceId: seed.workspace.id,
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });
    // .strict() schema → an extra `method` key is rejected by Zod inside executeTool
    await expect(
      executeTool(
        tok,
        'agent:op',
        'folio_api_get',
        {
          path: `/api/v1/w/${seed.workspace.slug}/p/${seed.project.slug}/tables`,
          method: 'POST',
        },
        undefined,
        { callerScopes: tok.scopes },
      ),
    ).rejects.toThrow();
  });

  test('folio_api_get is gated by the token read scope — no documents:read → forbidden (P3-4)', async () => {
    const { seed } = await makeTestApp();
    const tok = callerToken({
      workspaceId: seed.workspace.id,
      scopes: [], // no documents:read
      createdBy: seed.user.id,
    });
    await expect(
      executeTool(
        tok,
        'agent:op',
        'folio_api_get',
        { path: `/api/v1/w/${seed.workspace.slug}/p/${seed.project.slug}/tables` },
        undefined,
        { callerScopes: tok.scopes },
      ),
    ).rejects.toThrow();
  });

  test('folio_api_get against ai-keys returns NO encrypted key (P3-4)', async () => {
    const { seed } = await makeTestApp();
    const tok = callerToken({
      workspaceId: seed.workspace.id,
      scopes: ['documents:read'],
      createdBy: seed.user.id,
    });
    // ai-keys GET is mounted at /settings/:workspaceId/ai-keys under wScope; the
    // handler strips encryptedKey from every row. Hitting the real handler (200,
    // keys:[] when none seeded) proves the redaction, not a 404 vacuous pass.
    const out = (await executeTool(
      tok,
      'agent:op',
      'folio_api_get',
      { path: `/api/v1/w/${seed.workspace.slug}/settings/${seed.workspace.id}/ai-keys` },
      undefined,
      { callerScopes: tok.scopes },
    )) as { status: number; body: unknown };
    expect(out.status).toBe(200); // hit the real handler, not a 404
    expect(JSON.stringify(out)).not.toMatch(/encrypted_?[Kk]ey/);
  });
});
