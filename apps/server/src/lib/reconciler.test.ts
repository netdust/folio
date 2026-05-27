import { test, expect } from 'bun:test';
import { eq, and } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { makeTestApp } from '../test/harness.ts';
import { documents, projects, events, apiTokens } from '../db/schema.ts';
import { db } from '../db/client.ts';
import { reconcileAllowLists } from './reconciler.ts';
import { newApiToken } from './auth.ts';

async function seedAgent(workspaceId: string, slug: string, projectsList: string[]) {
  const id = nanoid();
  const { hash } = newApiToken();
  const tokenId = nanoid();
  await db.insert(apiTokens).values({
    id: tokenId,
    workspaceId,
    name: `agent-${slug}-token`,
    tokenHash: hash,
    scopes: ['documents:read'],
    createdBy: null,
  });
  await db.insert(documents).values({
    id,
    workspaceId,
    projectId: null,
    type: 'agent',
    slug,
    title: `Agent ${slug}`,
    body: '',
    frontmatter: {
      system_prompt: 'x',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      tools: ['list_documents'],
      projects: projectsList,
      api_token_id: tokenId,
    },
  });
  return id;
}

async function seedProject(workspaceId: string, slug: string) {
  const id = nanoid();
  await db.insert(projects).values({ id, workspaceId, slug, name: slug });
  return id;
}

test('reconcileAllowLists scrubs orphan project ids from an explicit allow-list', async () => {
  const { seed } = await makeTestApp();
  const wsId = seed.workspace.id;
  const prA = await seedProject(wsId, 'a');
  const prB = await seedProject(wsId, 'b');
  const agentId = await seedAgent(wsId, 'd', [prA, prB]);
  // Delete prB directly to simulate orphan.
  await db.delete(projects).where(eq(projects.id, prB));

  const fired: Array<{ agentId: string; removed: string[] }> = [];
  const result = await reconcileAllowLists(db, {
    onEvent: (e) => fired.push({ agentId: e.agentId, removed: e.removed }),
  });
  expect(result.agentsTouched).toBe(1);
  expect(result.totalRemoved).toBe(1);
  expect(fired).toHaveLength(1);
  expect(fired[0]!.removed).toEqual([prB]);

  const after = await db.select().from(documents).where(eq(documents.id, agentId));
  expect((after[0]!.frontmatter as Record<string, unknown>).projects).toEqual([prA]);

  // Event row written.
  const evtRows = await db
    .select()
    .from(events)
    .where(and(eq(events.workspaceId, wsId), eq(events.kind, 'agent.allow_list.reconciled')));
  expect(evtRows).toHaveLength(1);
  expect((evtRows[0]!.payload as Record<string, unknown>).agent_id).toBe(agentId);
  expect((evtRows[0]!.payload as Record<string, unknown>).removed_project_ids).toEqual([prB]);
});

test('reconcileAllowLists skips wildcard agents', async () => {
  const { seed } = await makeTestApp();
  await seedAgent(seed.workspace.id, 'star', ['*']);

  const fired: Array<unknown> = [];
  const result = await reconcileAllowLists(db, { onEvent: (e) => fired.push(e) });
  expect(result.agentsTouched).toBe(0);
  expect(fired).toHaveLength(0);
});

test('reconcileAllowLists no-ops when nothing to scrub', async () => {
  const { seed } = await makeTestApp();
  const pr = await seedProject(seed.workspace.id, 'p');
  await seedAgent(seed.workspace.id, 'clean', [pr]);

  const result = await reconcileAllowLists(db);
  expect(result.agentsTouched).toBe(0);
  expect(result.totalRemoved).toBe(0);

  const evtRows = await db
    .select()
    .from(events)
    .where(and(eq(events.workspaceId, seed.workspace.id), eq(events.kind, 'agent.allow_list.reconciled')));
  expect(evtRows).toHaveLength(0);
});

test('reconcileAllowLists is idempotent — second run is a no-op', async () => {
  const { seed } = await makeTestApp();
  const wsId = seed.workspace.id;
  const prA = await seedProject(wsId, 'a');
  const prB = await seedProject(wsId, 'b');
  await seedAgent(wsId, 'd', [prA, prB]);
  await db.delete(projects).where(eq(projects.id, prB));

  const first = await reconcileAllowLists(db);
  expect(first.agentsTouched).toBe(1);

  const second = await reconcileAllowLists(db);
  expect(second.agentsTouched).toBe(0);
  expect(second.totalRemoved).toBe(0);
});

test('reconcileAllowLists scrubs multiple orphans on the same agent', async () => {
  const { seed } = await makeTestApp();
  const wsId = seed.workspace.id;
  const prA = await seedProject(wsId, 'a');
  const prB = await seedProject(wsId, 'b');
  const prC = await seedProject(wsId, 'c');
  const agentId = await seedAgent(wsId, 'd', [prA, prB, prC]);
  await db.delete(projects).where(eq(projects.id, prB));
  await db.delete(projects).where(eq(projects.id, prC));

  const result = await reconcileAllowLists(db);
  expect(result.agentsTouched).toBe(1);
  expect(result.totalRemoved).toBe(2);

  const after = await db.select().from(documents).where(eq(documents.id, agentId));
  expect((after[0]!.frontmatter as Record<string, unknown>).projects).toEqual([prA]);
});

test('reconcileAllowLists honors custom actor', async () => {
  const { seed } = await makeTestApp();
  const wsId = seed.workspace.id;
  const prA = await seedProject(wsId, 'a');
  const prB = await seedProject(wsId, 'b');
  await seedAgent(wsId, 'd', [prA, prB]);
  await db.delete(projects).where(eq(projects.id, prB));

  await reconcileAllowLists(db, { actor: 'cli:stefan' });
  const evtRows = await db
    .select()
    .from(events)
    .where(and(eq(events.workspaceId, wsId), eq(events.kind, 'agent.allow_list.reconciled')));
  expect(evtRows[0]!.actor).toBe('cli:stefan');
});
