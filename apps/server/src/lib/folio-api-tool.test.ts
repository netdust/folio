import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { apiTokens, type ApiToken, workspaces } from '../db/schema.ts';
import { OPERATOR_AGENT_SENTINEL_ID } from '../services/conversation-runs.ts';
import { makeTestApp } from '../test/harness.ts';
import { roleToScopes } from './agent-schema.ts';
import { executeTool } from './agent-tools.ts';
import { registerRealTools } from './agent-tools-registry.ts';
import {
  dispatchAsCaller,
  isSecretWrite,
  pathToScope,
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
  test('rejects the SSE events stream routes (no-hang guard)', () => {
    expect(() => validateApiPath('/api/v1/w/acme/events')).toThrow();
    expect(() => validateApiPath('/api/v1/w/acme/p/web/events')).toThrow();
    expect(() => validateApiPath('/api/v1/w/acme/events/')).toThrow();
  });
  test('does NOT reject paths that merely contain "events" as a non-final segment', () => {
    // a hypothetical resource path with events earlier is still fine — only the
    // trailing /events stream route is blocked
    expect(validateApiPath('/api/v1/w/acme/p/web/events-archive')).toBe(
      '/api/v1/w/acme/p/web/events-archive',
    );
  });
});

describe('pathToScope + isSecretWrite (A6 scope gate, T5/T6)', () => {
  test('pathToScope maps the write surfaces', () => {
    expect(pathToScope('PATCH', '/api/v1/w/acme/settings/x/ai-keys')).toBe('SECRET');
    expect(pathToScope('POST',  '/api/v1/w/acme/tokens')).toBe('SECRET');
    expect(pathToScope('PATCH', '/api/v1/w/acme')).toBe('workspace:admin');
    expect(pathToScope('DELETE','/api/v1/w/acme')).toBe('workspace:admin');
    expect(pathToScope('POST',  '/api/v1/w/acme/members')).toBe('members:write');
    expect(pathToScope('PATCH', '/api/v1/w/acme/settings/x')).toBe('settings:write');
    expect(pathToScope('POST',  '/api/v1/w/acme/p/x/tables')).toBe('config:write');
    expect(pathToScope('DELETE','/api/v1/w/acme/p/x/views/v1')).toBe('config:write');
    expect(pathToScope('POST',  '/api/v1/w/acme/projects')).toBe('config:write');
    expect(pathToScope('PATCH', '/api/v1/w/acme/p/x')).toBe('config:write');
    expect(pathToScope('POST',  '/api/v1/w/acme/p/x/documents')).toBe('documents:write');
    expect(pathToScope('POST',  '/api/v1/w/acme/p/x/comments')).toBe('documents:write');
    expect(pathToScope('GET',   '/api/v1/w/acme/p/x/tables')).toBe(null); // reads not gated here
  });
  test('an UNMAPPED write path returns UNMAPPED (default-deny signal, T5)', () => {
    expect(pathToScope('POST', '/api/v1/w/acme/p/x/some-future-route')).toBe('UNMAPPED');
  });
  test('isSecretWrite is true only for tokens + ai-keys writes (T6)', () => {
    expect(isSecretWrite('POST', '/api/v1/w/acme/tokens')).toBe(true);
    expect(isSecretWrite('PATCH', '/api/v1/w/acme/settings/x/ai-keys')).toBe(true);
    expect(isSecretWrite('PATCH', '/api/v1/w/acme/settings/x')).toBe(false); // settings != secret
    expect(isSecretWrite('GET', '/api/v1/w/acme/tokens')).toBe(false); // read
  });

  test('the INSTANCE AI-key route is SECRET-classed (T8/M1 — never agent-writable)', () => {
    // AI-key CRUD moved to /api/v1/instance/ai-keys (T7). The `/ai-keys` keyword
    // branch must still classify it SECRET so the fail-closed pre-check refuses
    // any agent that somehow targets it (defense-in-depth behind the route's own
    // session-only gate). Guard test — keeps the new path covered.
    expect(pathToScope('POST', '/api/v1/instance/ai-keys')).toBe('SECRET');
    expect(pathToScope('DELETE', '/api/v1/instance/ai-keys/k1')).toBe('SECRET');
    expect(isSecretWrite('POST', '/api/v1/instance/ai-keys')).toBe(true);
    expect(isSecretWrite('DELETE', '/api/v1/instance/ai-keys/k1')).toBe(true);
    expect(isSecretWrite('GET', '/api/v1/instance/ai-keys')).toBe(false); // read not a secret-WRITE
  });

  // CR#1 — a document addressed by a slug that EQUALS a route keyword must NOT
  // collide with the config/secret keyword branches. A doc titled "Tokens"
  // (slug 'tokens') → PATCH .../documents/tokens must classify documents:write,
  // never SECRET. Same for 'members','settings','tables','ai-keys', etc.
  describe('CR#1 — document slug never collides with a route keyword', () => {
    const slugs = ['tokens', 'ai-keys', 'members', 'settings', 'tables', 'fields', 'views', 'statuses', 'projects'];
    for (const slug of slugs) {
      test(`document slug '${slug}' → documents:write, not SECRET/config (project-level)`, () => {
        const path = `/api/v1/w/acme/p/proj/documents/${slug}`;
        expect(isSecretWrite('PATCH', path)).toBe(false);
        expect(pathToScope('PATCH', path)).toBe('documents:write');
      });
      test(`document slug '${slug}' → documents:write (workspace-level docs)`, () => {
        const path = `/api/v1/w/acme/documents/${slug}`;
        expect(isSecretWrite('PATCH', path)).toBe(false);
        expect(pathToScope('PATCH', path)).toBe('documents:write');
      });
      test(`document slug '${slug}' → documents:write (table-scoped docs)`, () => {
        const path = `/api/v1/w/acme/p/proj/t/work-items/documents/${slug}`;
        expect(isSecretWrite('PATCH', path)).toBe(false);
        expect(pathToScope('PATCH', path)).toBe('documents:write');
      });
    }

    test('comment under a doc slugged like a keyword → documents:write', () => {
      expect(pathToScope('POST', '/api/v1/w/acme/p/proj/documents/tokens/comments')).toBe(
        'documents:write',
      );
      expect(isSecretWrite('POST', '/api/v1/w/acme/p/proj/documents/tokens/comments')).toBe(false);
    });

    test('comment item slugged like a keyword → documents:write', () => {
      expect(pathToScope('PATCH', '/api/v1/w/acme/p/proj/comments/settings')).toBe(
        'documents:write',
      );
    });

    test('run id-addressed writes → documents:write (workspace + project runs)', () => {
      expect(pathToScope('POST', '/api/v1/w/acme/runs/run123/cancel')).toBe('documents:write');
      expect(pathToScope('POST', '/api/v1/w/acme/p/proj/runs')).toBe('documents:write');
    });

    // Regression: the REAL config/secret routes still map to the SAME scope as
    // before the anchoring — no route is downgraded.
    test('real routes still classify correctly (no regression)', () => {
      expect(pathToScope('POST', '/api/v1/w/acme/tokens')).toBe('SECRET');
      expect(pathToScope('PATCH', '/api/v1/w/acme/settings/x/ai-keys')).toBe('SECRET');
      expect(pathToScope('PATCH', '/api/v1/w/acme')).toBe('workspace:admin');
      expect(pathToScope('DELETE', '/api/v1/w/acme')).toBe('workspace:admin');
      expect(pathToScope('POST', '/api/v1/w/acme/members')).toBe('members:write');
      expect(pathToScope('PATCH', '/api/v1/w/acme/settings/x')).toBe('settings:write');
      expect(pathToScope('POST', '/api/v1/w/acme/p/x/tables')).toBe('config:write');
      expect(pathToScope('POST', '/api/v1/w/acme/p/x/t/work-items/fields')).toBe('config:write');
      expect(pathToScope('POST', '/api/v1/w/acme/projects')).toBe('config:write');
      expect(pathToScope('PATCH', '/api/v1/w/acme/p/x')).toBe('config:write');
      expect(pathToScope('POST', '/api/v1/w/acme/p/x/documents')).toBe('documents:write');
      expect(pathToScope('PATCH', '/api/v1/w/acme/p/x/documents/normal')).toBe('documents:write');
    });
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

  // The operator is a CODE SINGLETON with no `documents` row; its ephemeral
  // token carries the synthetic agentId `operator:_operator`. Minting a persisted
  // api_tokens row with that agentId violates the api_tokens.agent_id →
  // documents.id FK (errno 787). dispatchAsCaller must null the agentId for the
  // operator (its reach is already clamped to agent ∩ caller upstream; the
  // null-agentId authority path re-checks the owner's grants). Regression for the
  // first-real-use FK crash on folio_api_get during a cockpit turn.
  test('operator caller (synthetic agentId) does not violate the agent_id FK (instance reach)', async () => {
    const { seed } = await makeTestApp();
    const operator = callerToken({
      workspaceId: null, // instance reach (operator is instance-wide)
      scopes: ['config:write', 'documents:read'],
      createdBy: seed.user.id,
      agentId: OPERATOR_AGENT_SENTINEL_ID, // synthetic — NO documents row
    });
    const res = await dispatchAsCaller(
      operator,
      'GET',
      `/api/v1/w/${seed.workspace.slug}/p/${seed.project.slug}/views`,
      undefined,
    );
    expect(res.status).toBe(200); // not a 500 from the FK crash
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
    // UPDATED 2026-06-03: AI-key CRUD moved to the INSTANCE route
    // /api/v1/instance/ai-keys (session-only, __system-admin gated, mounted on v1
    // where attachToken never runs). An agent token can therefore NEVER reach the
    // key store at all — strictly stronger than the old per-workspace redaction
    // (M1/M4). Assert the agent is blocked (401/403), and that no secret leaks.
    const out = (await executeTool(
      tok,
      'agent:op',
      'folio_api_get',
      { path: `/api/v1/instance/ai-keys` },
      undefined,
      { callerScopes: tok.scopes },
    )) as { status: number; body: unknown };
    expect([401, 403]).toContain(out.status); // unreachable by an agent token
    expect(JSON.stringify(out)).not.toMatch(/encrypted_?[Kk]ey/);
  });
});

describe('folio_api write tool (P3-6/7)', () => {
  test('folio_api rejects method GET (P3-6)', async () => {
    const { seed } = await makeTestApp();
    const tok = callerToken({
      workspaceId: seed.workspace.id,
      scopes: ['config:write', 'documents:read'],
      createdBy: seed.user.id,
    });
    await expect(
      executeTool(
        tok,
        'agent:op',
        'folio_api',
        {
          method: 'GET',
          path: `/api/v1/w/${seed.workspace.slug}/p/${seed.project.slug}/tables`,
          body: {},
        },
        undefined,
        { callerScopes: tok.scopes },
      ),
    ).rejects.toThrow();
  });

  test('folio_api medium write (config) executes → 201 (P3-7)', async () => {
    const { seed } = await makeTestApp();
    const tok = callerToken({
      workspaceId: seed.workspace.id,
      scopes: ['config:write', 'documents:read'],
      createdBy: seed.user.id,
    });
    const out = (await executeTool(
      tok,
      'agent:op',
      'folio_api',
      {
        method: 'POST',
        path: `/api/v1/w/${seed.workspace.slug}/p/${seed.project.slug}/tables`,
        body: { name: 'Sprints' },
      },
      undefined,
      { callerScopes: tok.scopes },
    )) as { status: number; body: unknown };
    expect(out.status).toBe(201);
  });

  // Phase C C3 — the unattended (trigger-fired) MEDIUM floor.
  test('folio_api MEDIUM write REFUSES on an unattended (trigger-fired) run (C3)', async () => {
    const { seed, db: testDb } = await makeTestApp();
    const tok = callerToken({
      workspaceId: seed.workspace.id,
      scopes: ['config:write', 'documents:read'],
      createdBy: seed.user.id,
    });
    const tablesBefore = (await testDb.query.tables.findMany()).length;
    const out = (await executeTool(
      tok,
      'agent:op',
      'folio_api',
      {
        method: 'POST',
        path: `/api/v1/w/${seed.workspace.slug}/p/${seed.project.slug}/tables`,
        body: { name: 'Sprints' },
      },
      undefined,
      // The run-derived second field: a fired run has no human in the loop.
      { callerScopes: tok.scopes, unattended: true },
    )) as { refused: boolean; reason: string; plan: { method: string; path: string } };
    expect(out.refused).toBe(true);
    expect(out.plan).toBeDefined();
    expect(out.reason).toMatch(/config-class write \(config:write\)/);
    expect(out.plan.method).toBe('POST');
    // No dispatch: the tables count is unchanged (refuse-with-plan, not applied).
    expect((await testDb.query.tables.findMany()).length).toBe(tablesBefore);
  });

  test('folio_api MEDIUM write still EXECUTES on an attended run (unattended:false) (C3)', async () => {
    const { seed } = await makeTestApp();
    const tok = callerToken({
      workspaceId: seed.workspace.id,
      scopes: ['config:write', 'documents:read'],
      createdBy: seed.user.id,
    });
    const out = (await executeTool(
      tok,
      'agent:op',
      'folio_api',
      {
        method: 'POST',
        path: `/api/v1/w/${seed.workspace.slug}/p/${seed.project.slug}/tables`,
        body: { name: 'Sprints' },
      },
      undefined,
      { callerScopes: tok.scopes, unattended: false },
    )) as { status?: number; refused?: boolean };
    // Attended path keeps Phase B MEDIUM behaviour: dispatched + created.
    expect(out.refused).toBeUndefined();
    expect(out.status).toBe(201);
  });

  test('folio_api low write (document create) dispatches and succeeds (P3-7)', async () => {
    const { seed } = await makeTestApp();
    // The folio_api write tool itself is gated by config:write at the
    // executeTool layer (caller + token must both hold it). The documents POST
    // route additionally requires documents:write. A low-tier classification
    // (a /p/:slug/documents create) auto-dispatches rather than refusing, so
    // give the token both scopes.
    const tok = callerToken({
      workspaceId: seed.workspace.id,
      scopes: ['config:write', 'documents:write', 'documents:read'],
      createdBy: seed.user.id,
    });
    const out = (await executeTool(
      tok,
      'agent:op',
      'folio_api',
      {
        method: 'POST',
        path: `/api/v1/w/${seed.workspace.slug}/p/${seed.project.slug}/documents`,
        body: { type: 'work_item', title: 'A task' },
      },
      undefined,
      { callerScopes: tok.scopes },
    )) as { status: number; refused?: boolean };
    // The seeded project's default "Work Items" table is auto-attached on the
    // /p/:slug URL, so the work_item create resolves a table and returns 201.
    expect(out.status).toBe(201); // dispatched + succeeded (NOT refused)
    expect(out.refused).toBeUndefined(); // low tier does not refuse
  });

  test('folio_api workspace-delete REFUSES on a token lacking workspace:admin (T-scope)', async () => {
    const { seed, db: testDb } = await makeTestApp();
    // DELETE /w/:slug maps to workspace:admin; this token does not hold it →
    // refuse via the double-gate, no dispatch.
    const tok = callerToken({
      workspaceId: seed.workspace.id,
      scopes: ['config:write', 'documents:read'],
      createdBy: seed.user.id,
    });
    const before = (await testDb.select().from(workspaces)).length;
    const tokensBefore = await countTokens();
    const out = (await executeTool(
      tok,
      'agent:op',
      'folio_api',
      { method: 'DELETE', path: `/api/v1/w/${seed.workspace.slug}`, body: {} },
      undefined,
      { callerScopes: tok.scopes },
    )) as { refused: boolean; reason: string; plan: { method: string; path: string } };
    expect(out.refused).toBe(true);
    expect(out.plan).toBeDefined();
    expect(out.reason).toMatch(/missing scope workspace:admin/);
    expect(out.plan.method).toBe('DELETE');
    expect((await testDb.select().from(workspaces)).length).toBe(before); // no mutation
    expect(await countTokens()).toBe(tokensBefore); // refuse branch did NOT mint
  });

  test('UNMAPPED write path REFUSES (default-deny, T5)', async () => {
    const { seed, db: testDb } = await makeTestApp();
    const tok = callerToken({
      workspaceId: seed.workspace.id,
      scopes: roleToScopes('owner'), // even a full-scope caller is refused
      createdBy: seed.user.id,
    });
    const tokensBefore = await countTokens();
    const out = (await executeTool(
      tok,
      'agent:op',
      'folio_api',
      {
        method: 'POST',
        path: `/api/v1/w/${seed.workspace.slug}/p/${seed.project.slug}/some-future-route`,
        body: {},
      },
      undefined,
      { callerScopes: tok.scopes },
    )) as { refused: boolean; reason: string; plan: { method: string; path: string } };
    expect(out.refused).toBe(true);
    expect(out.reason).toMatch(/no scope mapping/);
    expect(out.plan.method).toBe('POST');
    expect(await countTokens()).toBe(tokensBefore); // default-deny did NOT mint/dispatch
  });

  test('secret write (POST /tokens) REFUSES even for a full-scope instance-style token (T6)', async () => {
    // T6: secret-class writes are NEVER applied by an agent — for the MOST
    // privileged caller (every scope incl. workspace:admin). No bypass.
    const { seed, db: testDb } = await makeTestApp();
    const owner = callerToken({
      workspaceId: seed.workspace.id,
      scopes: roleToScopes('owner'), // all scopes — the highest-privilege caller
      createdBy: seed.user.id,
    });
    const before = (await testDb.select().from(workspaces)).length;
    const tokensBefore = await countTokens();
    const out = (await executeTool(
      owner,
      'agent:op',
      'folio_api',
      {
        method: 'POST',
        path: `/api/v1/w/${seed.workspace.slug}/tokens`,
        body: { name: 'minted-by-agent', scopes: ['documents:read'] },
      },
      undefined,
      { callerScopes: owner.scopes },
    )) as { refused: boolean; reason: string; plan: { method: string; path: string } };
    expect(out.refused).toBe(true);
    expect(out.plan).toBeDefined();
    expect(out.reason).toMatch(/secret-class write/);
    expect(out.plan.method).toBe('POST');
    expect((await testDb.select().from(workspaces)).length).toBe(before); // no mutation
    expect(await countTokens()).toBe(tokensBefore); // secret branch did NOT mint/dispatch
  });
});
