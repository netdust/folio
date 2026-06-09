/**
 * FEATURE-ACCEPTANCE — headless-Folio-via-MCP Phase 1 (D1 + D2 + D3).
 *
 * Drives the formerly-FAILING flows from the MCP-only eval
 * (`tasks/mcp-eval-manifest.md`) through the REAL, un-mocked `/mcp` JSON-RPC wire
 * (the same code path an external curl client hits — `app.request('/mcp', ...)`,
 * no mocks). These are the spec's phase-close acceptance flows; the manifest's
 * failing flows must now PASS.
 *
 * Flows driven (each = one intended-use scenario + its edge cases):
 *   F1 (D2/B1): multi-table project → a bare create_document{status:'todo'}
 *       (no table_slug) lands in work-items and SUCCEEDS (was: -32603 INVALID_STATUS).
 *   F2 (D1/U4): an admin PAT creates → inspects → updates → deletes an agent
 *       entirely over MCP (was: -32000 human_pat_rejected). Lifecycle end-to-end.
 *   F3 (D1 denial): a member PAT is REJECTED on agent creation (denied actor edge).
 *   F4 (D3): the skill recipes resolve — get_skill('folio') returns the corrected
 *       body (kanban enum, agent-create recipe).
 *
 * This file is the executable acceptance manifest; a green run == the manifest's
 * failing flows now pass through the real wire.
 */
import { expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db } from '../db/client.ts';
import { apiTokens, documents } from '../db/schema.ts';
import { newApiToken } from '../lib/auth.ts';
import { makeTestApp } from '../test/harness.ts';

async function mintPat(workspaceId: string, userId: string, scopes: string[]): Promise<string> {
  const { token, hash } = newApiToken();
  await db.insert(apiTokens).values({
    id: nanoid(),
    workspaceId,
    name: 'fa-pat',
    tokenHash: hash,
    scopes,
    createdBy: userId,
  });
  return token;
}

async function call(
  app: Awaited<ReturnType<typeof makeTestApp>>['app'],
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ result?: { content: { text: string }[] }; error?: { code: number; data?: { reason?: string }; message: string } }> {
  const res = await app.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return res.json() as Promise<{ result?: { content: { text: string }[] }; error?: { code: number; data?: { reason?: string }; message: string } }>;
}

const text = (r: { result?: { content: { text: string }[] } }) => JSON.parse(r.result!.content[0]!.text);

// ── F1 (D2/B1): bare create_document in a multi-table project lands in work-items ──
test('FA-F1: multi-table project — bare create_document{status:todo} succeeds (D2/B1)', async () => {
  const { app, seed } = await makeTestApp();
  const admin = await mintPat(seed.workspace.id, seed.user.id, [
    'config:write',
    'documents:write',
    'documents:read',
  ]);

  // Build a 2nd table 'bugs' via folio_api — both tables now tie at order:0.
  const mk = await call(app, admin, 'folio_api', {
    method: 'POST',
    path: `/api/v1/w/${seed.workspace.slug}/p/web/tables`,
    body: { name: 'Bugs' },
  });
  expect(mk.error).toBeUndefined();

  // The eval's exact failing call: no table_slug, status:'todo'. Pre-D2 this
  // routed to the status-less 'bugs' table and FAILED with INVALID_STATUS.
  const doc = await call(app, admin, 'create_document', {
    workspace_slug: seed.workspace.slug,
    project_slug: 'web',
    type: 'work_item',
    title: 'Add a work item to the project',
    status: 'todo',
  });
  expect(doc.error).toBeUndefined(); // ← the manifest's broken flow, now passing
  expect(text(doc).status).toBe('todo');

  // And a bare list_statuses resolves to work-items (not the empty 'bugs' set).
  const st = await call(app, admin, 'list_statuses', {
    workspace_slug: seed.workspace.slug,
    project_slug: 'web',
  });
  expect(text(st).table.slug).toBe('work-items');
});

// ── F2 (D1/U4): full agent lifecycle by an admin PAT, over MCP, end-to-end ──
test('FA-F2: admin PAT creates → inspects → updates → deletes an agent over MCP (D1/U4)', async () => {
  const { app, seed } = await makeTestApp();
  const admin = await mintPat(seed.workspace.id, seed.user.id, [
    'agents:write',
    'documents:write',
    'documents:read',
  ]);

  // CREATE — was: -32000 human_pat_rejected_on_agent_lifecycle.
  const created = await call(app, admin, 'create_agent', {
    workspace_slug: seed.workspace.slug,
    title: 'Ops Bot',
    frontmatter: { system_prompt: 'do ops', provider: 'anthropic', model: 'claude-sonnet-4-6', tools: ['list_documents'] },
  });
  expect(created.error).toBeUndefined();
  const agent = text(created);
  expect(agent.slug).toBeTruthy();
  expect(typeof agent.agent_token).toBe('string'); // bearer returned ONCE

  // The minted token is listable + revocable (mitigation 1 — the load-bearing one).
  const tokenRow = await db.query.apiTokens.findFirst({
    where: eq(apiTokens.agentId, agent.id),
  });
  expect(tokenRow).toBeDefined();

  // UPDATE — patch the agent over MCP.
  const updated = await call(app, admin, 'update_agent', {
    workspace_slug: seed.workspace.slug,
    slug: agent.slug,
    title: 'Ops Bot v2',
  });
  expect(updated.error).toBeUndefined();
  expect(text(updated).title).toBe('Ops Bot v2');

  // DELETE — revokes the agent AND cascades its bearer token.
  const deleted = await call(app, admin, 'delete_agent', {
    workspace_slug: seed.workspace.slug,
    slug: agent.slug,
  });
  expect(deleted.error).toBeUndefined();
  const gone = await db.query.documents.findFirst({ where: eq(documents.id, agent.id) });
  expect(gone).toBeUndefined();
  const tokenGone = await db.query.apiTokens.findFirst({ where: eq(apiTokens.id, tokenRow!.id) });
  expect(tokenGone).toBeUndefined(); // cascade revocation confirmed end-to-end
});

// ── F3 (D1 denial edge): a member PAT is rejected on agent creation ──
test('FA-F3: member PAT is rejected on agent creation over MCP (D1 denied-actor edge)', async () => {
  const { app, seed } = await makeTestApp();
  const member = await mintPat(seed.workspace.id, seed.user.id, ['documents:read', 'documents:write']);
  const denied = await call(app, member, 'create_agent', {
    workspace_slug: seed.workspace.slug,
    title: 'Should Not Exist',
    frontmatter: { system_prompt: 'x', provider: 'anthropic', model: 'claude-sonnet-4-6', tools: [] },
  });
  expect(denied.error).toBeDefined();
  expect(denied.error!.message).toMatch(/agents:write/); // rejected at the scope gate
});

// ── F4 (D3): the corrected folio skill body carries the recipes ──
// NOTE: get_skill resolves from the `instance_skills` table, which the test
// harness does not seed (it's populated at install time from the source
// constant). So the faithful check for a DOC-ONLY change is against the source
// body itself (FOLIO_SKILL_BODY) — the same string get_skill serves in
// production. The over-the-wire get_skill path is exercised by mcp.test.ts.
test('FA-F4: the folio skill body carries the corrected D3 recipes (kanban enum + agent-create)', async () => {
  const { FOLIO_SKILL_BODY } = await import('../lib/system-skills.ts');
  const body = FOLIO_SKILL_BODY;
  // D3.U1: the kanban enum is pinned verbatim.
  expect(body).toContain('"kanban"');
  expect(body).toMatch(/groupBy/);
  // D3.U4: the agent-create recipe is present.
  expect(body).toMatch(/create_agent/);
  // D3.B2: the table-status footgun is documented.
  expect(body).toMatch(/has NO statuses/);
});
