import { test, expect } from 'bun:test';
import { nanoid } from 'nanoid';
import { makeTestApp } from '../test/harness.ts';
import { projects } from '../db/schema.ts';

const WS_PATH = '/api/v1/w/acme/documents';

async function postWorkspaceDoc(
  app: Awaited<ReturnType<typeof makeTestApp>>['app'],
  cookie: string,
  body: Record<string, unknown>,
) {
  return app.request(WS_PATH, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('POST /api/v1/w/:wslug/documents creates an agent with workspace_id and project_id NULL', async () => {
  const { app, seed } = await makeTestApp();
  const res = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent',
    title: 'Triage Bot',
    frontmatter: {
      system_prompt: 'Triage incoming work.',
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      tools: ['list_documents'],
    },
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.data.type).toBe('agent');
  expect(body.data.workspaceId).toBe(seed.workspace.id);
  expect(body.data.projectId ?? null).toBeNull();
  // Default applied by the Zod schema.
  expect(body.data.frontmatter.projects).toEqual(['*']);
});

test('POST rejects non-agent, non-trigger types', async () => {
  const { app, seed } = await makeTestApp();
  const res = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'work_item',
    title: 'No work items at workspace level',
  });
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('INVALID_DOCUMENT_SCOPE');
});

test('POST agent with explicit projects list persists the array', async () => {
  const { app, db, seed } = await makeTestApp();
  // Add a second project so the array references real ids.
  const projectBId = nanoid();
  await db.insert(projects).values({
    id: projectBId,
    workspaceId: seed.workspace.id,
    slug: 'inbox',
    name: 'Inbox',
  });

  const res = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent',
    title: 'Inbox Triager',
    frontmatter: {
      system_prompt: 'Only Inbox.',
      model: 'm',
      provider: 'anthropic',
      tools: [],
      projects: [projectBId],
    },
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body.data.frontmatter.projects).toEqual([projectBId]);
});

test('POST agent with wildcard mixed in explicit list is 422', async () => {
  const { app, seed } = await makeTestApp();
  const res = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent',
    title: 'Bad',
    frontmatter: {
      system_prompt: 'x',
      model: 'm',
      provider: 'anthropic',
      tools: [],
      projects: ['*', 'whatever'],
    },
  });
  expect(res.status).toBe(422);
  const body = await res.json();
  expect(body.error.code).toBe('INVALID_AGENT_FRONTMATTER');
});

test('GET ?type=agent returns workspace agents', async () => {
  const { app, seed } = await makeTestApp();
  await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'A',
    frontmatter: { system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [] },
  });
  await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'B',
    frontmatter: { system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [] },
  });
  const res = await app.request(`${WS_PATH}?type=agent`, { headers: { Cookie: seed.sessionCookie } });
  const body = await res.json();
  expect(body.data).toHaveLength(2);
});

test('GET ?type=agent&project=:pid filters by allow-list membership', async () => {
  const { app, db, seed } = await makeTestApp();
  const projectBId = nanoid();
  await db.insert(projects).values({
    id: projectBId,
    workspaceId: seed.workspace.id,
    slug: 'inbox',
    name: 'Inbox',
  });

  // Two agents: one project-A-only, one wildcard.
  await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'A-only',
    frontmatter: {
      system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [],
      projects: [seed.project.id],
    },
  });
  await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'Wildcard',
    frontmatter: {
      system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [],
      projects: ['*'],
    },
  });

  // Filter to project B: only the wildcard agent matches.
  const res = await app.request(`${WS_PATH}?type=agent&project=${projectBId}`, {
    headers: { Cookie: seed.sessionCookie },
  });
  const body = await res.json();
  const titles = body.data.map((d: { title: string }) => d.title);
  expect(titles).toEqual(['Wildcard']);
});

test('PATCH updates agent frontmatter.projects', async () => {
  const { app, db, seed } = await makeTestApp();
  const projectBId = nanoid();
  await db.insert(projects).values({
    id: projectBId,
    workspaceId: seed.workspace.id,
    slug: 'inbox',
    name: 'Inbox',
  });

  const createRes = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'A',
    frontmatter: {
      system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [],
      projects: [seed.project.id],
    },
  });
  const created = (await createRes.json()).data;

  // PATCH only the changed field — sending the full frontmatter back would
  // include server-managed `api_token_id` which the .strict() schema rejects.
  const patchRes = await app.request(`${WS_PATH}/${created.slug}`, {
    method: 'PATCH',
    headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      frontmatter: { projects: [seed.project.id, projectBId] },
    }),
  });
  expect(patchRes.status).toBe(200);
  const updated = (await patchRes.json()).data;
  expect(updated.frontmatter.projects).toEqual([seed.project.id, projectBId]);
});

test('DELETE removes the agent + cascades the token', async () => {
  const { app, db, seed } = await makeTestApp();
  const create = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'Goner',
    frontmatter: { system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [] },
  });
  const created = (await create.json()).data;

  const del = await app.request(`${WS_PATH}/${created.slug}`, {
    method: 'DELETE',
    headers: { Cookie: seed.sessionCookie },
  });
  expect(del.status).toBe(204);

  const { apiTokens, documents } = await import('../db/schema.ts');
  const { eq } = await import('drizzle-orm');
  const remainingDoc = await db.query.documents.findFirst({ where: eq(documents.id, created.id) });
  expect(remainingDoc).toBeUndefined();
  const remainingTokens = await db.query.apiTokens.findMany({
    where: eq(apiTokens.agentId, created.id),
  });
  expect(remainingTokens).toHaveLength(0);
});

test('two agents in the same workspace can share a base slug only after disambiguation', async () => {
  const { app, seed } = await makeTestApp();
  const first = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'Bot',
    frontmatter: { system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [] },
  });
  const second = await postWorkspaceDoc(app, seed.sessionCookie, {
    type: 'agent', title: 'Bot',
    frontmatter: { system_prompt: 'x', model: 'm', provider: 'anthropic', tools: [] },
  });
  expect((await first.json()).data.slug).toBe('bot');
  expect((await second.json()).data.slug).toBe('bot-2');
});
