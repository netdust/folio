import { test, expect } from 'bun:test';
import { nanoid } from 'nanoid';
import { makeTestApp } from '../test/harness.ts';
import { db } from '../db/client.ts';
import { apiTokens } from '../db/schema.ts';
import { newApiToken } from '../lib/auth.ts';

async function setupToken(
  workspaceId: string,
  userId: string,
  scopes: string[],
): Promise<string> {
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId,
    name: 'mcp-test',
    tokenHash: hash,
    scopes,
    createdBy: userId,
  });
  return token;
}

test('MCP rejects requests without a Bearer token', async () => {
  const { app } = await makeTestApp();
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  expect(res.status).toBe(401);
});

test('MCP initialize returns serverInfo + protocolVersion', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: { serverInfo: { name: string }; protocolVersion: string } };
  expect(body.result.serverInfo.name).toBe('folio');
  expect(body.result.protocolVersion).toBeTruthy();
});

test('MCP tools/list returns the v1 tools including comment + agent-lifecycle tools', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const body = (await res.json()) as { result: { tools: { name: string }[] } };
  // 12 original + 4 comment tools + 4 agent-lifecycle tools + 5 run-management
  // tools (D-4) + 1 find_documents tool + 1 describe_workspace tool + 1
  // folio_api_get (Phase-op-3 T4 reads) + 1 folio_api (Phase-op-3 T5 writes) = 29.
  expect(body.result.tools.length).toBe(29);
  const names = body.result.tools.map((t) => t.name);
  expect(names).toContain('folio_api_get');
  expect(names).toContain('folio_api'); // T5 registers the write tool
  expect(names).toContain('find_documents');
  expect(names).toContain('describe_workspace');
  expect(names).toContain('create_comment');
  expect(names).toContain('list_comments');
  expect(names).toContain('update_comment');
  expect(names).toContain('delete_comment');
  expect(names).toContain('create_agent');
  expect(names).toContain('update_agent');
  expect(names).toContain('delete_agent');
  expect(names).toContain('get_agent_self');
  expect(names).toContain('list_runs');
  expect(names).toContain('get_run');
  expect(names).toContain('run_agent');
  expect(names).toContain('cancel_run');
  expect(names).toContain('retry_run');
});

test('MCP tools/call list_workspaces returns the workspaces visible to the token', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_workspaces', arguments: {} },
    }),
  });
  const body = (await res.json()) as { result: { content: { type: string; text: string }[] } };
  expect(body.result.content[0]!.type).toBe('text');
  const parsed = JSON.parse(body.result.content[0]!.text) as { workspaces: unknown[] };
  expect(parsed.workspaces.length).toBeGreaterThan(0);
});

test('MCP tools/call create_document requires documents:write', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'create_document',
        arguments: {
          workspace_slug: 'acme',
          project_slug: 'web',
          type: 'work_item',
          title: 'from mcp',
        },
      },
    }),
  });
  const body = (await res.json()) as { error?: { code: number; message: string } };
  expect(body.error).toBeDefined();
  expect(body.error!.code).toBe(-32603);
  expect(body.error!.message).toMatch(/documents:write/);
});

test('MCP tools/call create_document works with documents:write', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, [
    'documents:write',
    'documents:read',
  ]);
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'create_document',
        arguments: {
          workspace_slug: 'acme',
          project_slug: 'web',
          type: 'work_item',
          title: 'from mcp',
        },
      },
    }),
  });
  const body = (await res.json()) as { result?: { content: { type: string; text: string }[] } };
  expect(body.result).toBeDefined();
  const parsed = JSON.parse(body.result!.content[0]!.text) as { title: string };
  expect(parsed.title).toBe('from mcp');
});

async function callTool(
  app: Awaited<ReturnType<typeof makeTestApp>>['app'],
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Response> {
  return app.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
}

test('MCP tools/call update_document patches title + frontmatter', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, [
    'documents:write',
    'documents:read',
  ]);
  const created = await callTool(app, token, 'create_document', {
    workspace_slug: 'acme',
    project_slug: 'web',
    type: 'work_item',
    title: 'original',
    frontmatter: { priority: 'low' },
  });
  const createdBody = (await created.json()) as { result: { content: { text: string }[] } };
  const createdDoc = JSON.parse(createdBody.result.content[0]!.text) as { slug: string };

  const res = await callTool(app, token, 'update_document', {
    workspace_slug: 'acme',
    project_slug: 'web',
    slug: createdDoc.slug,
    title: 'patched',
    frontmatter: { priority: 'high' },
  });
  const body = (await res.json()) as { result?: { content: { text: string }[] }; error?: unknown };
  expect(body.error).toBeUndefined();
  const parsed = JSON.parse(body.result!.content[0]!.text) as {
    title: string;
    frontmatter: Record<string, unknown>;
  };
  expect(parsed.title).toBe('patched');
  expect(parsed.frontmatter['priority']).toBe('high');
});

test('MCP tools/call delete_document requires documents:delete and removes the doc', async () => {
  const { app, seed } = await makeTestApp();
  const writeOnly = await setupToken(seed.workspace.id, seed.user.id, [
    'documents:write',
    'documents:read',
  ]);
  const created = await callTool(app, writeOnly, 'create_document', {
    workspace_slug: 'acme',
    project_slug: 'web',
    type: 'work_item',
    title: 'to delete',
  });
  const createdBody = (await created.json()) as { result: { content: { text: string }[] } };
  const createdDoc = JSON.parse(createdBody.result.content[0]!.text) as { slug: string };

  // Write+read scopes are insufficient — delete needs documents:delete.
  const blocked = await callTool(app, writeOnly, 'delete_document', {
    workspace_slug: 'acme',
    project_slug: 'web',
    slug: createdDoc.slug,
  });
  const blockedBody = (await blocked.json()) as { error?: { message: string } };
  expect(blockedBody.error).toBeDefined();
  expect(blockedBody.error!.message).toMatch(/documents:delete/);

  // With the right scope the delete goes through and the doc disappears.
  const deleter = await setupToken(seed.workspace.id, seed.user.id, [
    'documents:delete',
    'documents:read',
  ]);
  const ok = await callTool(app, deleter, 'delete_document', {
    workspace_slug: 'acme',
    project_slug: 'web',
    slug: createdDoc.slug,
  });
  const okBody = (await ok.json()) as { result?: { content: { text: string }[] }; error?: unknown };
  expect(okBody.error).toBeUndefined();
  const parsed = JSON.parse(okBody.result!.content[0]!.text) as { ok: boolean; slug: string };
  expect(parsed.ok).toBe(true);
  expect(parsed.slug).toBe(createdDoc.slug);

  const reader = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const lookup = await callTool(app, reader, 'get_document', {
    workspace_slug: 'acme',
    project_slug: 'web',
    slug: createdDoc.slug,
  });
  const lookupBody = (await lookup.json()) as { error?: { message: string } };
  expect(lookupBody.error).toBeDefined();
  expect(lookupBody.error!.message).toMatch(/document not found/);
});

test('tools/call ignores any caller authority smuggled in params (D2 — token is the authority)', async () => {
  // D2 lock: the bearer token is the SOLE source of caller authority. A client
  // that forges caller_scopes / callerScopes in the request body must NOT gain
  // the scope it lacks. Here the token holds only write+read (no
  // documents:delete); the body smuggles documents:delete via every plausible
  // shape. delete_document must still be denied for the missing scope.
  const { app, seed } = await makeTestApp();
  const writeOnly = await setupToken(seed.workspace.id, seed.user.id, [
    'documents:write',
    'documents:read',
  ]);
  const created = await callTool(app, writeOnly, 'create_document', {
    workspace_slug: 'acme',
    project_slug: 'web',
    type: 'work_item',
    title: 'd2-guard',
  });
  const createdBody = (await created.json()) as { result: { content: { text: string }[] } };
  const createdDoc = JSON.parse(createdBody.result.content[0]!.text) as { slug: string };

  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${writeOnly}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      // Forged authority at both the params level and inside arguments — none of
      // it must be honored. Authority comes only from the authenticated token.
      caller_scopes: ['documents:delete'],
      callerScopes: ['documents:delete'],
      callerProjectIds: null,
      params: {
        name: 'delete_document',
        caller_scopes: ['documents:delete'],
        callerScopes: ['documents:delete'],
        arguments: {
          workspace_slug: 'acme',
          project_slug: 'web',
          slug: createdDoc.slug,
          caller_scopes: ['documents:delete'],
          callerScopes: ['documents:delete'],
          callerProjectIds: null,
        },
      },
    }),
  });
  const body = (await res.json()) as { error?: { message: string }; result?: unknown };
  expect(body.result).toBeUndefined();
  expect(body.error).toBeDefined();
  expect(body.error!.message).toMatch(/documents:delete/);
});

test('MCP tools/call list_statuses returns the seeded default statuses', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const res = await callTool(app, token, 'list_statuses', {
    workspace_slug: 'acme',
    project_slug: 'web',
  });
  const body = (await res.json()) as { result: { content: { text: string }[] }; error?: unknown };
  expect(body.error).toBeUndefined();
  const parsed = JSON.parse(body.result.content[0]!.text) as {
    table: { slug: string };
    statuses: { key: string }[];
  };
  expect(parsed.statuses.length).toBeGreaterThan(0);
  expect(parsed.table.slug).toBeTruthy();
});

test('MCP tools/call run_view returns documents for the default view', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, [
    'documents:write',
    'documents:read',
  ]);
  await callTool(app, token, 'create_document', {
    workspace_slug: 'acme',
    project_slug: 'web',
    type: 'work_item',
    title: 'view target',
  });

  const res = await callTool(app, token, 'run_view', {
    workspace_slug: 'acme',
    project_slug: 'web',
  });
  const body = (await res.json()) as { result?: { content: { text: string }[] }; error?: unknown };
  expect(body.error).toBeUndefined();
  const parsed = JSON.parse(body.result!.content[0]!.text) as {
    view: { id: string };
    documents: { title: string }[];
  };
  expect(parsed.view.id).toBeTruthy();
  expect(parsed.documents.some((d) => d.title === 'view target')).toBe(true);
});

// --- Phase 2.5: agent allow-list enforcement ---

import { documents, projects as projectsTbl } from '../db/schema.ts';

/** Mint an agent doc + an agent-bound token for tests. */
async function setupAgentBoundToken(
  workspaceId: string,
  userId: string,
  opts: { projects: string[]; scopes?: string[]; agentSlug?: string },
): Promise<{ agentToken: string; agentId: string; agentSlug: string }> {
  const agentId = nanoid();
  const agentSlug = opts.agentSlug ?? `agent-${nanoid(6)}`;
  await db.insert(documents).values({
    id: agentId,
    projectId: null,
    workspaceId,
    tableId: null,
    type: 'agent',
    slug: agentSlug,
    title: 'Test Agent',
    status: null,
    // The agent body IS the prompt (snapshot at run-create); createRun rejects
    // an empty body, so seed a non-empty one.
    body: 'help',
    frontmatter: {
      system_prompt: 'help',
      model: 'm',
      provider: 'anthropic',
      tools: ['list_documents', 'create_document'],
      projects: opts.projects,
    },
    createdBy: userId,
    updatedBy: userId,
  });
  const { token: plaintext, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId,
    name: `agent:${agentSlug}`,
    tokenHash: hash,
    scopes: opts.scopes ?? ['documents:read', 'documents:write', 'documents:delete'],
    agentId,
    createdBy: userId,
  });
  return { agentToken: plaintext, agentId, agentSlug };
}

test('list_projects filters by agent allow-list (explicit ids)', async () => {
  const { app, db: testDb, seed } = await makeTestApp();
  // Add a second project.
  const projectBId = nanoid();
  await testDb.insert(projectsTbl).values({
    id: projectBId,
    workspaceId: seed.workspace.id,
    slug: 'inbox',
    name: 'Inbox',
  });
  const { agentToken } = await setupAgentBoundToken(seed.workspace.id, seed.user.id, {
    projects: [seed.project.id], // only project A
  });
  const res = await callTool(app, agentToken, 'list_projects', { workspace_slug: 'acme' });
  const body = (await res.json()) as { result: { content: { text: string }[] } };
  const parsed = JSON.parse(body.result.content[0]!.text) as {
    projects: { slug: string }[];
  };
  const slugs = parsed.projects.map((p) => p.slug);
  expect(slugs).toContain('web');     // project A
  expect(slugs).not.toContain('inbox'); // project B not in allow-list
});

test('list_projects returns all when agent.projects = ["*"]', async () => {
  const { app, db: testDb, seed } = await makeTestApp();
  const projectBId = nanoid();
  await testDb.insert(projectsTbl).values({
    id: projectBId,
    workspaceId: seed.workspace.id,
    slug: 'inbox',
    name: 'Inbox',
  });
  const { agentToken } = await setupAgentBoundToken(seed.workspace.id, seed.user.id, {
    projects: ['*'],
  });
  const res = await callTool(app, agentToken, 'list_projects', { workspace_slug: 'acme' });
  const body = (await res.json()) as { result: { content: { text: string }[] } };
  const parsed = JSON.parse(body.result.content[0]!.text) as {
    projects: { slug: string }[];
  };
  const slugs = parsed.projects.map((p) => p.slug);
  expect(slugs).toContain('web');
  expect(slugs).toContain('inbox');
});

test('list_documents on a disallowed project returns -32602 with reason agent_not_in_allow_list', async () => {
  const { app, db: testDb, seed } = await makeTestApp();
  const projectBId = nanoid();
  await testDb.insert(projectsTbl).values({
    id: projectBId,
    workspaceId: seed.workspace.id,
    slug: 'inbox',
    name: 'Inbox',
  });
  const { agentToken } = await setupAgentBoundToken(seed.workspace.id, seed.user.id, {
    projects: [seed.project.id], // project A only
  });
  const res = await callTool(app, agentToken, 'list_documents', {
    workspace_slug: 'acme',
    project_slug: 'inbox',
  });
  const body = (await res.json()) as {
    error: { code: number; data?: { reason: string } };
  };
  expect(body.error.code).toBe(-32602);
  expect(body.error.data?.reason).toBe('agent_not_in_allow_list');
});

test('create_document with type=agent is rejected via MCP in Phase 2.5', async () => {
  const { app, seed } = await makeTestApp();
  const { agentToken } = await setupAgentBoundToken(seed.workspace.id, seed.user.id, {
    projects: ['*'],
  });
  const res = await callTool(app, agentToken, 'create_document', {
    workspace_slug: 'acme',
    project_slug: 'web',
    type: 'agent',
    title: 'No can do',
    frontmatter: { system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [] },
  });
  const body = (await res.json()) as { error: { code: number; message: string } };
  expect(body.error.code).toBe(-32602);
  expect(body.error.message).toMatch(/workspace-scoped HTTP endpoint/);
});

test('create_document with type=trigger is rejected via MCP in Phase 2.5', async () => {
  const { app, seed } = await makeTestApp();
  const { agentToken } = await setupAgentBoundToken(seed.workspace.id, seed.user.id, {
    projects: ['*'],
  });
  const res = await callTool(app, agentToken, 'create_document', {
    workspace_slug: 'acme',
    project_slug: 'web',
    type: 'trigger',
    title: 'Nope',
    frontmatter: { agent: 'x', schedule: '0 9 * * 1', on_event: null },
  });
  const body = (await res.json()) as { error: { code: number } };
  expect(body.error.code).toBe(-32602);
});

test('human PAT (no agent_id) is not subject to allow-list checks', async () => {
  const { app, db: testDb, seed } = await makeTestApp();
  const projectBId = nanoid();
  await testDb.insert(projectsTbl).values({
    id: projectBId,
    workspaceId: seed.workspace.id,
    slug: 'inbox',
    name: 'Inbox',
  });
  const humanToken = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const res = await callTool(app, humanToken, 'list_projects', { workspace_slug: 'acme' });
  const body = (await res.json()) as { result: { content: { text: string }[] } };
  const parsed = JSON.parse(body.result.content[0]!.text) as {
    projects: { slug: string }[];
  };
  expect(parsed.projects.map((p) => p.slug)).toEqual(['inbox', 'web'].sort());
});

// ---------------------------------------------------------------------------
// Phase 2.6 — comment tools
//
// These exercise the 4 new MCP tools (create/list/update/delete_comment).
// Author resolution: agent-bound tokens post as `agent:<slug>`, human PATs as
// `user:<id>`. Author-only enforcement on update/delete surfaces as
// JSON-RPC -32602 with data.reason='comment_author_only'.
// ---------------------------------------------------------------------------

/** Create a project-scoped work_item via the create_document tool; returns its slug. */
async function createWorkItem(
  app: Awaited<ReturnType<typeof makeTestApp>>['app'],
  token: string,
  title: string,
): Promise<string> {
  const res = await callTool(app, token, 'create_document', {
    workspace_slug: 'acme',
    project_slug: 'web',
    type: 'work_item',
    title,
  });
  const body = (await res.json()) as { result: { content: { text: string }[] } };
  const doc = JSON.parse(body.result.content[0]!.text) as { slug: string };
  return doc.slug;
}

test('create_comment via agent token resolves author=agent:<id> and emits comment.created', async () => {
  const { app, seed } = await makeTestApp();
  const { agentToken, agentId } = await setupAgentBoundToken(
    seed.workspace.id,
    seed.user.id,
    { projects: ['*'] },
  );
  // Use the human session to create the parent — agents can create too, but
  // this isolates the parent-creation from the comment-creation.
  const human = await setupToken(seed.workspace.id, seed.user.id, [
    'documents:write',
    'documents:read',
  ]);
  const parentSlug = await createWorkItem(app, human, 'parent A');

  const res = await callTool(app, agentToken, 'create_comment', {
    workspace_slug: 'acme',
    project_slug: 'web',
    parent_slug: parentSlug,
    body: 'hello from the agent',
  });
  const body = (await res.json()) as {
    result?: { content: { text: string }[] };
    error?: unknown;
  };
  expect(body.error).toBeUndefined();
  const parsed = JSON.parse(body.result!.content[0]!.text) as {
    slug: string;
    kind: string;
  };
  expect(parsed.slug).toMatch(/^c-/);
  expect(parsed.kind).toBe('comment');

  // Verify the persisted row + emitted event.
  const { db } = await import('../db/client.ts');
  const { documents, events } = await import('../db/schema.ts');
  const { eq } = await import('drizzle-orm');
  const row = await db.query.documents.findFirst({
    where: eq(documents.slug, parsed.slug),
  });
  expect(row).toBeTruthy();
  const fm = row!.frontmatter as Record<string, unknown>;
  // F11 — canonical author for new comments is `agent:<id>`, not `agent:<slug>`.
  // Slug-based authoring broke after rename; id-based survives renames.
  expect(fm.author).toBe(`agent:${agentId}`);
  const evRows = await db.query.events.findMany({ where: eq(events.kind, 'comment.created') });
  expect(evRows.length).toBe(1);
  expect((evRows[0]!.payload as Record<string, unknown>).author).toBe(`agent:${agentId}`);
});

test('create_comment via human PAT resolves author=user:<id>', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, [
    'documents:write',
    'documents:read',
  ]);
  const parentSlug = await createWorkItem(app, token, 'parent B');

  const res = await callTool(app, token, 'create_comment', {
    workspace_slug: 'acme',
    project_slug: 'web',
    parent_slug: parentSlug,
    body: 'from the human',
  });
  const body = (await res.json()) as { result?: { content: { text: string }[] }; error?: unknown };
  expect(body.error).toBeUndefined();
  const parsed = JSON.parse(body.result!.content[0]!.text) as { slug: string };

  const { db } = await import('../db/client.ts');
  const { documents } = await import('../db/schema.ts');
  const { eq } = await import('drizzle-orm');
  const row = await db.query.documents.findFirst({ where: eq(documents.slug, parsed.slug) });
  const fm = row!.frontmatter as Record<string, unknown>;
  expect(fm.author).toBe(`user:${seed.user.id}`);
});

test('create_comment without documents:write returns -32603 with required_scope', async () => {
  const { app, seed } = await makeTestApp();
  const readOnly = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  // Build a parent via a separate write-capable token so we have something to point at.
  const writer = await setupToken(seed.workspace.id, seed.user.id, [
    'documents:write',
    'documents:read',
  ]);
  const parentSlug = await createWorkItem(app, writer, 'parent C');

  const res = await callTool(app, readOnly, 'create_comment', {
    workspace_slug: 'acme',
    project_slug: 'web',
    parent_slug: parentSlug,
    body: 'should be blocked',
  });
  const body = (await res.json()) as {
    error: { code: number; message: string; data?: { required_scope: string } };
  };
  expect(body.error.code).toBe(-32603);
  expect(body.error.data?.required_scope).toBe('documents:write');
});

test('create_comment on a project outside the agent allow-list → -32602 agent_not_in_allow_list', async () => {
  const { app, db: testDb, seed } = await makeTestApp();
  // Second project the agent can NOT see.
  const otherProjectId = nanoid();
  await testDb.insert(projectsTbl).values({
    id: otherProjectId,
    workspaceId: seed.workspace.id,
    slug: 'inbox',
    name: 'Inbox',
  });
  // Agent allowed only on the original "web" project.
  const { agentToken } = await setupAgentBoundToken(seed.workspace.id, seed.user.id, {
    projects: [seed.project.id],
  });

  // The parent must exist in `inbox` for resolveProjectInWorkspace to evaluate;
  // we don't actually need to seed defaults there because the allow-list check
  // happens before parent lookup.
  const res = await callTool(app, agentToken, 'create_comment', {
    workspace_slug: 'acme',
    project_slug: 'inbox',
    parent_slug: 'whatever',
    body: 'should be rejected',
  });
  const body = (await res.json()) as {
    error: { code: number; data?: { reason: string } };
  };
  expect(body.error.code).toBe(-32602);
  expect(body.error.data?.reason).toBe('agent_not_in_allow_list');
});

test('create_comment with a non-existent parent slug → error propagates', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, [
    'documents:write',
    'documents:read',
  ]);
  const res = await callTool(app, token, 'create_comment', {
    workspace_slug: 'acme',
    project_slug: 'web',
    parent_slug: 'does-not-exist',
    body: 'orphan',
  });
  const body = (await res.json()) as { error: { code: number; message: string } };
  expect(body.error).toBeDefined();
  expect(body.error.message).toMatch(/parent.*not found/);
});

test('list_comments returns newest-first list', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, [
    'documents:write',
    'documents:read',
  ]);
  const parentSlug = await createWorkItem(app, token, 'parent L');
  await callTool(app, token, 'create_comment', {
    workspace_slug: 'acme',
    project_slug: 'web',
    parent_slug: parentSlug,
    body: 'first',
  });
  // Tiny gap to make the createdAt ordering deterministic.
  await new Promise((r) => setTimeout(r, 5));
  await callTool(app, token, 'create_comment', {
    workspace_slug: 'acme',
    project_slug: 'web',
    parent_slug: parentSlug,
    body: 'second',
  });

  const res = await callTool(app, token, 'list_comments', {
    workspace_slug: 'acme',
    project_slug: 'web',
    parent_slug: parentSlug,
  });
  const body = (await res.json()) as { result: { content: { text: string }[] }; error?: unknown };
  expect(body.error).toBeUndefined();
  const rows = JSON.parse(body.result.content[0]!.text) as { body: string }[];
  expect(rows.length).toBe(2);
  expect(rows[0]!.body).toBe('second'); // newest first
  expect(rows[1]!.body).toBe('first');
});

test('list_comments filters by kind=plan', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, [
    'documents:write',
    'documents:read',
  ]);
  const parentSlug = await createWorkItem(app, token, 'parent K');
  await callTool(app, token, 'create_comment', {
    workspace_slug: 'acme',
    project_slug: 'web',
    parent_slug: parentSlug,
    body: 'regular note',
  });
  await callTool(app, token, 'create_comment', {
    workspace_slug: 'acme',
    project_slug: 'web',
    parent_slug: parentSlug,
    body: 'the plan',
    kind: 'plan',
  });

  const res = await callTool(app, token, 'list_comments', {
    workspace_slug: 'acme',
    project_slug: 'web',
    parent_slug: parentSlug,
    kind: 'plan',
  });
  const body = (await res.json()) as { result: { content: { text: string }[] } };
  const rows = JSON.parse(body.result.content[0]!.text) as {
    body: string;
    frontmatter: { kind: string };
  }[];
  expect(rows.length).toBe(1);
  expect(rows[0]!.frontmatter.kind).toBe('plan');
});

test('list_comments default visibility excludes internal rows', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, [
    'documents:write',
    'documents:read',
  ]);
  const parentSlug = await createWorkItem(app, token, 'parent V');
  await callTool(app, token, 'create_comment', {
    workspace_slug: 'acme',
    project_slug: 'web',
    parent_slug: parentSlug,
    body: 'public',
  });
  await callTool(app, token, 'create_comment', {
    workspace_slug: 'acme',
    project_slug: 'web',
    parent_slug: parentSlug,
    body: 'secret',
    visibility: 'internal',
  });

  // Default — internal hidden.
  const def = await callTool(app, token, 'list_comments', {
    workspace_slug: 'acme',
    project_slug: 'web',
    parent_slug: parentSlug,
  });
  const defRows = JSON.parse(
    ((await def.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text,
  ) as { body: string }[];
  expect(defRows.length).toBe(1);
  expect(defRows[0]!.body).toBe('public');

  // Explicit override — both visible.
  const both = await callTool(app, token, 'list_comments', {
    workspace_slug: 'acme',
    project_slug: 'web',
    parent_slug: parentSlug,
    visibility: 'normal,internal',
  });
  const bothRows = JSON.parse(
    ((await both.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text,
  ) as { body: string }[];
  expect(bothRows.length).toBe(2);
});

test('update_comment by the author succeeds and stamps edited_at', async () => {
  const { app, seed } = await makeTestApp();
  const { agentToken } = await setupAgentBoundToken(seed.workspace.id, seed.user.id, {
    projects: ['*'],
  });
  const human = await setupToken(seed.workspace.id, seed.user.id, [
    'documents:write',
    'documents:read',
  ]);
  const parentSlug = await createWorkItem(app, human, 'parent U');

  const created = await callTool(app, agentToken, 'create_comment', {
    workspace_slug: 'acme',
    project_slug: 'web',
    parent_slug: parentSlug,
    body: 'v1',
  });
  const createdParsed = JSON.parse(
    ((await created.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text,
  ) as { slug: string };

  const res = await callTool(app, agentToken, 'update_comment', {
    workspace_slug: 'acme',
    project_slug: 'web',
    slug: createdParsed.slug,
    body: 'v2 updated',
  });
  const body = (await res.json()) as { result?: { content: { text: string }[] }; error?: unknown };
  expect(body.error).toBeUndefined();
  const parsed = JSON.parse(body.result!.content[0]!.text) as {
    slug: string;
    edited_at: string;
  };
  expect(parsed.slug).toBe(createdParsed.slug);
  expect(typeof parsed.edited_at).toBe('string');
  expect(parsed.edited_at.length).toBeGreaterThan(0);
});

test('update_comment changes visibility from normal to internal', async () => {
  const { app, seed } = await makeTestApp();
  const { agentToken } = await setupAgentBoundToken(seed.workspace.id, seed.user.id, {
    projects: ['*'],
  });
  const human = await setupToken(seed.workspace.id, seed.user.id, [
    'documents:write',
    'documents:read',
  ]);
  const parentSlug = await createWorkItem(app, human, 'parent VIS');

  // Create a comment with default (normal) visibility.
  const created = await callTool(app, agentToken, 'create_comment', {
    workspace_slug: 'acme',
    project_slug: 'web',
    parent_slug: parentSlug,
    body: 'initially normal',
  });
  const createdParsed = JSON.parse(
    ((await created.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text,
  ) as { slug: string };

  // Update visibility to internal (no body change).
  const res = await callTool(app, agentToken, 'update_comment', {
    workspace_slug: 'acme',
    project_slug: 'web',
    slug: createdParsed.slug,
    visibility: 'internal',
  });
  const body = (await res.json()) as { result?: { content: { text: string }[] }; error?: unknown };
  expect(body.error).toBeUndefined();

  // Verify the DB row reflects the new visibility.
  const { db } = await import('../db/client.ts');
  const { documents: docsTbl } = await import('../db/schema.ts');
  const { eq } = await import('drizzle-orm');
  const row = await db.query.documents.findFirst({
    where: eq(docsTbl.slug, createdParsed.slug),
  });
  expect(row).toBeTruthy();
  expect((row!.frontmatter as Record<string, unknown>).visibility).toBe('internal');
});

test('update_comment by a non-author agent → -32602 comment_author_only', async () => {
  const { app, seed } = await makeTestApp();
  const { agentToken: authorToken } = await setupAgentBoundToken(
    seed.workspace.id,
    seed.user.id,
    { projects: ['*'], agentSlug: 'author-bot' },
  );
  const { agentToken: otherToken } = await setupAgentBoundToken(
    seed.workspace.id,
    seed.user.id,
    { projects: ['*'], agentSlug: 'other-bot' },
  );
  const human = await setupToken(seed.workspace.id, seed.user.id, [
    'documents:write',
    'documents:read',
  ]);
  const parentSlug = await createWorkItem(app, human, 'parent AO');

  const created = await callTool(app, authorToken, 'create_comment', {
    workspace_slug: 'acme',
    project_slug: 'web',
    parent_slug: parentSlug,
    body: 'mine',
  });
  const createdParsed = JSON.parse(
    ((await created.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text,
  ) as { slug: string };

  const res = await callTool(app, otherToken, 'update_comment', {
    workspace_slug: 'acme',
    project_slug: 'web',
    slug: createdParsed.slug,
    body: 'hijacked',
  });
  const body = (await res.json()) as {
    error: { code: number; data?: { reason: string } };
  };
  expect(body.error.code).toBe(-32602);
  expect(body.error.data?.reason).toBe('comment_author_only');
});

test('delete_comment by the author soft-deletes the row', async () => {
  const { app, seed } = await makeTestApp();
  const { agentToken } = await setupAgentBoundToken(seed.workspace.id, seed.user.id, {
    projects: ['*'],
  });
  const human = await setupToken(seed.workspace.id, seed.user.id, [
    'documents:write',
    'documents:read',
  ]);
  const parentSlug = await createWorkItem(app, human, 'parent D');

  const created = await callTool(app, agentToken, 'create_comment', {
    workspace_slug: 'acme',
    project_slug: 'web',
    parent_slug: parentSlug,
    body: 'will be removed',
  });
  const createdParsed = JSON.parse(
    ((await created.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text,
  ) as { slug: string };

  const res = await callTool(app, agentToken, 'delete_comment', {
    workspace_slug: 'acme',
    project_slug: 'web',
    slug: createdParsed.slug,
  });
  const body = (await res.json()) as { result?: { content: { text: string }[] }; error?: unknown };
  expect(body.error).toBeUndefined();
  const parsed = JSON.parse(body.result!.content[0]!.text) as {
    slug: string;
    deleted_at: string;
  };
  expect(parsed.slug).toBe(createdParsed.slug);
  expect(typeof parsed.deleted_at).toBe('string');

  // Verify soft-delete: body cleared, deleted_at present, row still in DB.
  const { db } = await import('../db/client.ts');
  const { documents: docsTbl } = await import('../db/schema.ts');
  const { eq } = await import('drizzle-orm');
  const row = await db.query.documents.findFirst({
    where: eq(docsTbl.slug, createdParsed.slug),
  });
  expect(row).toBeTruthy();
  expect(row!.body).toBe('');
  expect((row!.frontmatter as Record<string, unknown>).deleted_at).toBeTruthy();
});

test('delete_comment by a non-author agent → -32602 comment_author_only', async () => {
  const { app, seed } = await makeTestApp();
  const { agentToken: authorToken } = await setupAgentBoundToken(
    seed.workspace.id,
    seed.user.id,
    { projects: ['*'], agentSlug: 'd-author' },
  );
  const { agentToken: otherToken } = await setupAgentBoundToken(
    seed.workspace.id,
    seed.user.id,
    { projects: ['*'], agentSlug: 'd-other' },
  );
  const human = await setupToken(seed.workspace.id, seed.user.id, [
    'documents:write',
    'documents:read',
  ]);
  const parentSlug = await createWorkItem(app, human, 'parent DOA');

  const created = await callTool(app, authorToken, 'create_comment', {
    workspace_slug: 'acme',
    project_slug: 'web',
    parent_slug: parentSlug,
    body: 'mine — do not touch',
  });
  const createdParsed = JSON.parse(
    ((await created.json()) as { result: { content: { text: string }[] } }).result.content[0]!.text,
  ) as { slug: string };

  const res = await callTool(app, otherToken, 'delete_comment', {
    workspace_slug: 'acme',
    project_slug: 'web',
    slug: createdParsed.slug,
  });
  const body = (await res.json()) as {
    error: { code: number; data?: { reason: string } };
  };
  expect(body.error.code).toBe(-32602);
  expect(body.error.data?.reason).toBe('comment_author_only');
});

// ---------------------------------------------------------------------------
// Phase 2.6 sub-phase D — agent-lifecycle tools.
//
// Tools: create_agent / update_agent / delete_agent / get_agent_self.
// Scope: write ops require `agents:write`; get_agent_self only needs
// documents:read (it's metadata-on-self resolved via the bearer's agent_id).
// Allow-list widening guard: an agent-bound token cannot patch a target
// agent's frontmatter.projects to add ids outside its own allow-list.
// Self-delete guard: an agent-bound token cannot delete its own agent.
// ---------------------------------------------------------------------------

test('MCP create_agent without agents:write returns -32603 scope rejection', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, [
    'documents:read',
    'documents:write',
    // intentionally NO agents:write
  ]);
  const res = await callTool(app, token, 'create_agent', {
    workspace_slug: 'acme',
    title: 'Helper',
    frontmatter: {
      system_prompt: 'help',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      tools: ['list_documents'],
    },
  });
  const body = (await res.json()) as { error?: { code: number; message: string } };
  expect(body.error).toBeDefined();
  expect(body.error!.code).toBe(-32603);
  expect(body.error!.message).toMatch(/agents:write/);
});

test('MCP create_agent mints a token and returns it ONCE in the response', async () => {
  const { app, seed } = await makeTestApp();
  // Round 6 #1: human PATs are now rejected on MCP agent-lifecycle tools.
  // The legitimate caller is an agent-bound bearer minting a child agent.
  const { agentToken } = await setupAgentBoundToken(seed.workspace.id, seed.user.id, {
    projects: ['*'],
    scopes: ['agents:write', 'documents:read'],
    agentSlug: 'parent-minter',
  });
  const res = await callTool(app, agentToken, 'create_agent', {
    workspace_slug: 'acme',
    title: 'Helper',
    frontmatter: {
      system_prompt: 'help',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      tools: ['list_documents'],
    },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result?: { content: { text: string }[] };
    error?: unknown;
  };
  expect(body.error).toBeUndefined();
  const parsed = JSON.parse(body.result!.content[0]!.text) as {
    slug: string;
    type: string;
    agent_token: string;
  };
  expect(parsed.type).toBe('agent');
  expect(parsed.slug).toBe('helper');
  expect(typeof parsed.agent_token).toBe('string');
  expect(parsed.agent_token.length).toBeGreaterThan(10);
});

test('MCP update_agent patches title + frontmatter', async () => {
  const { app, seed } = await makeTestApp();
  // Round 6 #1: agent-bound bearer required for MCP agent-lifecycle tools.
  const { agentToken } = await setupAgentBoundToken(seed.workspace.id, seed.user.id, {
    projects: ['*'],
    scopes: ['agents:write', 'documents:read'],
    agentSlug: 'parent-patcher',
  });
  await callTool(app, agentToken, 'create_agent', {
    workspace_slug: 'acme',
    title: 'Target',
    frontmatter: {
      system_prompt: 'one',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      tools: ['list_documents'],
    },
  });

  const res = await callTool(app, agentToken, 'update_agent', {
    workspace_slug: 'acme',
    slug: 'target',
    title: 'New Title',
    frontmatter: { system_prompt: 'two' },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result?: { content: { text: string }[] };
    error?: unknown;
  };
  expect(body.error).toBeUndefined();
  const parsed = JSON.parse(body.result!.content[0]!.text) as {
    title: string;
    frontmatter: Record<string, unknown>;
  };
  expect(parsed.title).toBe('New Title');
  expect(parsed.frontmatter['system_prompt']).toBe('two');
});

test('F2: MCP create_agent rejects allow-list widening beyond calling agent\'s own', async () => {
  const { app, db: testDb, seed } = await makeTestApp();
  const projectBId = nanoid();
  await testDb.insert(projectsTbl).values({
    id: projectBId,
    workspaceId: seed.workspace.id,
    slug: 'inbox',
    name: 'Inbox',
  });

  // Calling agent has only seed.project.id.
  const { agentToken: callerToken } = await setupAgentBoundToken(
    seed.workspace.id,
    seed.user.id,
    {
      projects: [seed.project.id],
      scopes: ['agents:write', 'documents:read'],
      agentSlug: 'caller-create',
    },
  );

  // Try to mint a CHILD agent with projects=['*'] (wider than caller's list).
  const res = await callTool(app, callerToken, 'create_agent', {
    workspace_slug: 'acme',
    title: 'Wider Child',
    frontmatter: {
      system_prompt: 'x',
      model: 'm',
      provider: 'anthropic',
      tools: [],
      projects: ['*'],
    },
  });
  const body = (await res.json()) as {
    error?: { code: number; data?: { reason: string } };
  };
  expect(body.error).toBeDefined();
  expect(body.error?.code).toBe(-32602);
  expect(body.error?.data?.reason).toBe('allow_list_widening_forbidden');
});

test('F2: MCP create_agent rejects widening to specific outside-list project ids', async () => {
  const { app, db: testDb, seed } = await makeTestApp();
  const projectBId = nanoid();
  await testDb.insert(projectsTbl).values({
    id: projectBId,
    workspaceId: seed.workspace.id,
    slug: 'inbox',
    name: 'Inbox',
  });

  const { agentToken: callerToken } = await setupAgentBoundToken(
    seed.workspace.id,
    seed.user.id,
    {
      projects: [seed.project.id],
      scopes: ['agents:write', 'documents:read'],
      agentSlug: 'caller-create-2',
    },
  );

  // projectBId is not in caller's allow-list — must reject.
  const res = await callTool(app, callerToken, 'create_agent', {
    workspace_slug: 'acme',
    title: 'Child With Foreign Project',
    frontmatter: {
      system_prompt: 'x',
      model: 'm',
      provider: 'anthropic',
      tools: [],
      projects: [seed.project.id, projectBId],
    },
  });
  const body = (await res.json()) as {
    error?: { code: number; data?: { reason: string } };
  };
  expect(body.error?.data?.reason).toBe('allow_list_widening_forbidden');
});

test('MCP update_agent rejects allow-list widening beyond calling agent\'s own', async () => {
  const { app, db: testDb, seed } = await makeTestApp();
  // Add a second project the calling agent does NOT have access to.
  const projectBId = nanoid();
  await testDb.insert(projectsTbl).values({
    id: projectBId,
    workspaceId: seed.workspace.id,
    slug: 'inbox',
    name: 'Inbox',
  });

  // Calling agent has [seed.project.id] only.
  const { agentToken: callerToken } = await setupAgentBoundToken(
    seed.workspace.id,
    seed.user.id,
    {
      projects: [seed.project.id],
      scopes: ['agents:write', 'documents:read'],
      agentSlug: 'caller',
    },
  );

  // Seed a target agent at workspace scope (uses helper that inserts directly
  // so we don't need agents:write on the human path).
  const { agentSlug: targetSlug } = await setupAgentBoundToken(
    seed.workspace.id,
    seed.user.id,
    { projects: [seed.project.id], agentSlug: 'target' },
  );

  // Try to widen the target's projects to include projectBId — caller can't do this.
  const res = await callTool(app, callerToken, 'update_agent', {
    workspace_slug: 'acme',
    slug: targetSlug,
    frontmatter: { projects: [seed.project.id, projectBId] },
  });
  const body = (await res.json()) as {
    error: { code: number; data?: { reason: string } };
  };
  expect(body.error).toBeDefined();
  expect(body.error.code).toBe(-32602);
  expect(body.error.data?.reason).toBe('allow_list_widening_forbidden');
});

test('MCP update_agent allows non-widening patches from an agent-bound token', async () => {
  const { app, seed } = await makeTestApp();
  // Caller and target both have [seed.project.id]; renaming target stays within.
  const { agentToken: callerToken } = await setupAgentBoundToken(
    seed.workspace.id,
    seed.user.id,
    {
      projects: [seed.project.id],
      scopes: ['agents:write', 'documents:read'],
      agentSlug: 'caller-narrow',
    },
  );
  const { agentSlug: targetSlug } = await setupAgentBoundToken(
    seed.workspace.id,
    seed.user.id,
    { projects: [seed.project.id], agentSlug: 'target-narrow' },
  );

  const res = await callTool(app, callerToken, 'update_agent', {
    workspace_slug: 'acme',
    slug: targetSlug,
    title: 'Narrowed Target',
  });
  const body = (await res.json()) as {
    result?: { content: { text: string }[] };
    error?: unknown;
  };
  expect(body.error).toBeUndefined();
  const parsed = JSON.parse(body.result!.content[0]!.text) as { title: string };
  expect(parsed.title).toBe('Narrowed Target');
});

test('MCP delete_agent removes the agent (agent-bound parent token)', async () => {
  const { app, seed } = await makeTestApp();
  // Round 6 #1: human PATs rejected — parent agent revokes a child it minted.
  const { agentToken } = await setupAgentBoundToken(seed.workspace.id, seed.user.id, {
    projects: ['*'],
    scopes: ['agents:write', 'documents:read'],
    agentSlug: 'parent-deleter',
  });
  await callTool(app, agentToken, 'create_agent', {
    workspace_slug: 'acme',
    title: 'Doomed',
    frontmatter: {
      system_prompt: 'p',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      tools: ['list_documents'],
    },
  });
  const res = await callTool(app, agentToken, 'delete_agent', {
    workspace_slug: 'acme',
    slug: 'doomed',
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result?: { content: { text: string }[] };
    error?: unknown;
  };
  expect(body.error).toBeUndefined();
  const parsed = JSON.parse(body.result!.content[0]!.text) as { ok: boolean; slug: string };
  expect(parsed.ok).toBe(true);
  expect(parsed.slug).toBe('doomed');
});

test('MCP delete_agent rejects self-delete from an agent-bound token', async () => {
  const { app, seed } = await makeTestApp();
  const { agentToken, agentSlug } = await setupAgentBoundToken(
    seed.workspace.id,
    seed.user.id,
    {
      projects: ['*'],
      scopes: ['agents:write', 'documents:read'],
      agentSlug: 'self-target',
    },
  );

  const res = await callTool(app, agentToken, 'delete_agent', {
    workspace_slug: 'acme',
    slug: agentSlug,
  });
  const body = (await res.json()) as {
    error: { code: number; data?: { reason: string } };
  };
  expect(body.error).toBeDefined();
  expect(body.error.code).toBe(-32602);
  expect(body.error.data?.reason).toBe('cannot_delete_self');
});

test('MCP get_agent_self returns the calling agent document', async () => {
  const { app, seed } = await makeTestApp();
  const { agentToken, agentSlug } = await setupAgentBoundToken(
    seed.workspace.id,
    seed.user.id,
    {
      projects: ['*'],
      scopes: ['documents:read'],
      agentSlug: 'self-reader',
    },
  );

  const res = await callTool(app, agentToken, 'get_agent_self', {});
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result?: { content: { text: string }[] };
    error?: unknown;
  };
  expect(body.error).toBeUndefined();
  const parsed = JSON.parse(body.result!.content[0]!.text) as {
    slug: string;
    type: string;
  };
  expect(parsed.slug).toBe(agentSlug);
  expect(parsed.type).toBe('agent');
});

test('MCP get_agent_self with a human PAT returns -32602 no_agent_bound_to_token', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, ['documents:read']);
  const res = await callTool(app, token, 'get_agent_self', {});
  const body = (await res.json()) as {
    error: { code: number; data?: { reason: string } };
  };
  expect(body.error).toBeDefined();
  expect(body.error.code).toBe(-32602);
  expect(body.error.data?.reason).toBe('no_agent_bound_to_token');
});

// ---------------------------------------------------------------------------
// Round 6 #1 — MCP agent-lifecycle tools reject human PATs.
//
// `create_agent` / `update_agent` / `delete_agent` are auth-grant mutations
// (they mint, modify, or revoke `agent_token` bearer credentials). A stolen
// human PAT with `agents:write` could mint a new agent with arbitrary scopes,
// escalating beyond the original PAT's scope set. Reject at dispatch with
// MCP error -32000 (round 7 #12 — was -32601, but SDKs route -32601 through
// the 'capability missing' handler and drop `data.reason`. -32000 preserves
// it.) + reason `human_pat_rejected_on_agent_lifecycle`.
//
// HTTP-side agent CRUD (POST/PATCH/DELETE /documents with type=agent) is
// intentionally NOT gated — that's the admin-facing surface. See threat-model
// mitigation 11.
// ---------------------------------------------------------------------------

test('MCP create_agent rejects human-PAT caller (round 6 #1)', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, [
    'agents:write',
    'documents:read',
  ]);
  const res = await callTool(app, token, 'create_agent', {
    workspace_slug: 'acme',
    title: 'Helper',
    frontmatter: {
      system_prompt: 'help',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      tools: ['list_documents'],
    },
  });
  const body = (await res.json()) as {
    error?: { code: number; data?: { reason: string } };
  };
  expect(body.error).toBeDefined();
  expect(body.error!.code).toBe(-32000);
  expect(body.error!.data?.reason).toBe('human_pat_rejected_on_agent_lifecycle');
});

test('MCP update_agent rejects human-PAT caller (round 6 #1)', async () => {
  const { app, seed } = await makeTestApp();
  // Seed an agent via agent-bound bearer (the legitimate path).
  const { agentToken } = await setupAgentBoundToken(seed.workspace.id, seed.user.id, {
    projects: ['*'],
    scopes: ['agents:write', 'documents:read'],
    agentSlug: 'r6-update-seed',
  });
  await callTool(app, agentToken, 'create_agent', {
    workspace_slug: 'acme',
    title: 'Existing',
    frontmatter: {
      system_prompt: 'p',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      tools: ['list_documents'],
    },
  });

  // Then attempt the patch via human PAT — must be rejected.
  const humanPat = await setupToken(seed.workspace.id, seed.user.id, [
    'agents:write',
    'documents:read',
  ]);
  const res = await callTool(app, humanPat, 'update_agent', {
    workspace_slug: 'acme',
    slug: 'existing',
    title: 'Patched',
  });
  const body = (await res.json()) as {
    error?: { code: number; data?: { reason: string } };
  };
  expect(body.error).toBeDefined();
  expect(body.error!.code).toBe(-32000);
  expect(body.error!.data?.reason).toBe('human_pat_rejected_on_agent_lifecycle');
});

test('MCP delete_agent rejects human-PAT caller (round 6 #1)', async () => {
  const { app, seed } = await makeTestApp();
  // Seed an agent via agent-bound bearer.
  const { agentToken } = await setupAgentBoundToken(seed.workspace.id, seed.user.id, {
    projects: ['*'],
    scopes: ['agents:write', 'documents:read'],
    agentSlug: 'r6-delete-seed',
  });
  await callTool(app, agentToken, 'create_agent', {
    workspace_slug: 'acme',
    title: 'Existing',
    frontmatter: {
      system_prompt: 'p',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      tools: ['list_documents'],
    },
  });

  const humanPat = await setupToken(seed.workspace.id, seed.user.id, [
    'agents:write',
    'documents:read',
  ]);
  const res = await callTool(app, humanPat, 'delete_agent', {
    workspace_slug: 'acme',
    slug: 'existing',
  });
  const body = (await res.json()) as {
    error?: { code: number; data?: { reason: string } };
  };
  expect(body.error).toBeDefined();
  expect(body.error!.code).toBe(-32000);
  expect(body.error!.data?.reason).toBe('human_pat_rejected_on_agent_lifecycle');
});

// ---------------------------------------------------------------------------
// F5 — MCP update_document / delete_document must NOT operate on comments.
//
// Comments live in `documents` with type='comment'. The generic doc tools
// previously only blocked agent/trigger, so any documents:write/delete token
// could bypass the comment author-only guard + soft-delete semantics.
// ---------------------------------------------------------------------------

test('G15: MCP create_document rejects type=comment with COMMENT_REQUIRES_COMMENT_TOOL', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, [
    'documents:write',
    'documents:read',
  ]);

  // Even with an existing parent, creating a comment via the generic doc
  // tool should be cleanly rejected (no opaque SQL constraint error).
  const res = await callTool(app, token, 'create_document', {
    workspace_slug: 'acme',
    project_slug: 'web',
    type: 'comment',
    title: 'forged',
    frontmatter: { author: 'user:victim', kind: 'approval' },
  });
  const body = (await res.json()) as {
    error?: { code: number; message: string };
  };
  expect(body.error).toBeDefined();
  // The HTTPError code surfaces in the message via the MCP outer catch.
  expect(body.error?.message).toMatch(/comment documents must be created via/i);
});

test('F5: MCP update_document rejects type=comment (must use update_comment)', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, [
    'documents:write',
    'documents:read',
  ]);

  // Create a parent + comment via the proper REST path.
  const parentRes = await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'Parent' }),
  });
  const parent = (await parentRes.json()).data as { slug: string };
  const commentRes = await app.request(`/api/v1/w/acme/p/web/documents/${parent.slug}/comments`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'original' }),
  });
  const comment = (await commentRes.json()).data as { slug: string };

  // Try to update via generic MCP tool.
  const res = await callTool(app, token, 'update_document', {
    workspace_slug: 'acme',
    project_slug: 'web',
    slug: comment.slug,
    body: 'tampered through generic tool',
  });
  const body = (await res.json()) as {
    error?: { code: number; data?: { reason: string } };
  };
  expect(body.error).toBeDefined();
  expect(body.error?.data?.reason).toBe('comment_requires_comment_tool');
});

test('F5: MCP delete_document rejects type=comment (must use delete_comment)', async () => {
  const { app, seed } = await makeTestApp();
  const token = await setupToken(seed.workspace.id, seed.user.id, [
    'documents:delete',
    'documents:read',
  ]);

  const parentRes = await app.request('/api/v1/w/acme/p/web/documents', {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'work_item', title: 'Parent' }),
  });
  const parent = (await parentRes.json()).data as { slug: string };
  const commentRes = await app.request(`/api/v1/w/acme/p/web/documents/${parent.slug}/comments`, {
    method: 'POST',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: 'to keep' }),
  });
  const comment = (await commentRes.json()).data as { slug: string };

  const res = await callTool(app, token, 'delete_document', {
    workspace_slug: 'acme',
    project_slug: 'web',
    slug: comment.slug,
  });
  const body = (await res.json()) as {
    error?: { code: number; data?: { reason: string } };
  };
  expect(body.error).toBeDefined();
  expect(body.error?.data?.reason).toBe('comment_requires_comment_tool');
});
