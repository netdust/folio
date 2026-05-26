import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { makeTestApp } from '../test/harness.ts';
import { apiTokens, documents, projects as projectsTbl } from '../db/schema.ts';
import { attachToken, intersect, requireResource, requireScope } from './bearer.ts';
import { resolveProject, resolveWorkspace } from './scope.ts';
import { attachUser } from './auth.ts';
import { newApiToken } from '../lib/auth.ts';
import { registerErrorHandler } from '../lib/http.ts';

describe('intersect(agentList, tokenList)', () => {
  test('(["*"], null) → ["*"] — wildcard inheritance', () => {
    expect(intersect(['*'], null)).toEqual(['*']);
  });

  test('(["*"], ["a","b"]) → ["a","b"] — token narrows wildcard', () => {
    expect(intersect(['*'], ['a', 'b'])).toEqual(['a', 'b']);
  });

  test('(["a","b","c"], ["b","c","d"]) → ["b","c"] — drop broadening attempt', () => {
    expect(intersect(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual(['b', 'c']);
  });

  test('(["a","b"], null) → ["a","b"] — token inherits', () => {
    expect(intersect(['a', 'b'], null)).toEqual(['a', 'b']);
  });

  test('(["a"], []) → [] — token revoked at resource layer', () => {
    expect(intersect(['a'], [])).toEqual([]);
  });

  test('([], null) → [] — agent has no projects', () => {
    expect(intersect([], null)).toEqual([]);
  });
});

/**
 * Build a workspace with two projects and an agent allow-listed for the
 * subset specified. Mints an agent-bound token; returns slugs + plaintext.
 */
async function setupAgentScenario(opts: {
  agentProjects: string[]; // ids from the returned `projects` map, or ['*']
  tokenProjectIds?: string[] | null; // null = inherit; default null
}) {
  const { db, seed } = await makeTestApp();
  const projectBId = nanoid();
  await db.insert(projectsTbl).values({
    id: projectBId,
    workspaceId: seed.workspace.id,
    slug: 'project-b',
    name: 'Project B',
  });

  // Map agent project ids — '*' stays as is, 'A' → seed.project.id, 'B' → projectBId.
  const resolveProjId = (sym: string) =>
    sym === 'A' ? seed.project.id : sym === 'B' ? projectBId : sym;
  const agentProjects = opts.agentProjects.map(resolveProjId);

  const agentId = nanoid();
  await db.insert(documents).values({
    id: agentId,
    projectId: null,
    workspaceId: seed.workspace.id,
    tableId: null,
    type: 'agent',
    slug: 'test-agent',
    title: 'Test Agent',
    status: null,
    body: '',
    frontmatter: {
      system_prompt: 'help',
      model: 'm',
      provider: 'anthropic',
      tools: ['list_documents'],
      projects: agentProjects,
    },
    createdBy: seed.user.id,
    updatedBy: seed.user.id,
  });

  const { token: plaintext, hash } = newApiToken();
  const tokenId = nanoid();
  await db.insert(apiTokens).values({
    id: tokenId,
    workspaceId: seed.workspace.id,
    name: 'agent:test-agent',
    tokenHash: hash,
    scopes: ['documents:read'],
    agentId,
    projectIds: opts.tokenProjectIds ?? null,
    createdBy: seed.user.id,
  });

  return {
    db,
    seed,
    projectA: { id: seed.project.id, slug: seed.project.slug },
    projectB: { id: projectBId, slug: 'project-b' },
    agentTokenPlaintext: plaintext,
  };
}

function makeAppWithGuards() {
  const app = new Hono<any>();
  registerErrorHandler(app);
  app.use('*', attachUser, attachToken);
  app.use(
    '/api/v1/w/:wslug/p/:pslug/*',
    resolveWorkspace,
    resolveProject,
    requireScope('documents:read'),
    requireResource(),
  );
  app.get('/api/v1/w/:wslug/p/:pslug/documents', (c) => c.json({ ok: true }));
  return app;
}

describe('requireResource middleware', () => {
  test('denies bearer when project not in agent allow-list', async () => {
    const { projectB, agentTokenPlaintext, seed } =
      await setupAgentScenario({ agentProjects: ['A'] });
    const app = makeAppWithGuards();
    const res = await app.request(
      `/api/v1/w/${seed.workspace.slug}/p/${projectB.slug}/documents`,
      { headers: { Authorization: `Bearer ${agentTokenPlaintext}` } },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN_RESOURCE');
  });

  test('allows bearer when project in agent allow-list', async () => {
    const { projectA, agentTokenPlaintext, seed } =
      await setupAgentScenario({ agentProjects: ['A'] });
    const app = makeAppWithGuards();
    const res = await app.request(
      `/api/v1/w/${seed.workspace.slug}/p/${projectA.slug}/documents`,
      { headers: { Authorization: `Bearer ${agentTokenPlaintext}` } },
    );
    expect(res.status).toBe(200);
  });

  test('allows bearer with wildcard agent on any project', async () => {
    const { projectB, agentTokenPlaintext, seed } =
      await setupAgentScenario({ agentProjects: ['*'] });
    const app = makeAppWithGuards();
    const res = await app.request(
      `/api/v1/w/${seed.workspace.slug}/p/${projectB.slug}/documents`,
      { headers: { Authorization: `Bearer ${agentTokenPlaintext}` } },
    );
    expect(res.status).toBe(200);
  });

  test('token-level projectIds narrows the agent wildcard', async () => {
    const { projectB, agentTokenPlaintext, seed } = await setupAgentScenario({
      agentProjects: ['*'],
      tokenProjectIds: [], // narrowed to nothing
    });
    const app = makeAppWithGuards();
    const res = await app.request(
      `/api/v1/w/${seed.workspace.slug}/p/${projectB.slug}/documents`,
      { headers: { Authorization: `Bearer ${agentTokenPlaintext}` } },
    );
    expect(res.status).toBe(403);
  });

  test('bypasses for session-authenticated requests', async () => {
    const { projectB, seed } = await setupAgentScenario({ agentProjects: ['A'] });
    const app = makeAppWithGuards();
    const res = await app.request(
      `/api/v1/w/${seed.workspace.slug}/p/${projectB.slug}/documents`,
      { headers: { Cookie: seed.sessionCookie } },
    );
    expect(res.status).toBe(200);
  });
});
