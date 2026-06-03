import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import {
  type Document,
  type Project,
  type TableEntity,
  type User,
  type Workspace,
  aiKeys,
  apiTokens,
  documents,
  tables,
} from '../db/schema.ts';
import { decryptSecret } from '../lib/crypto.ts';
import { newApiToken } from '../lib/auth.ts';
import { toolsToScopes } from '../lib/agent-schema.ts';
import { loadContext } from '../lib/runner.ts';
import { bootstrapSystemWorkspace, grantOwner } from '../lib/system-workspace.ts';
import { createRun } from '../services/agent-runs.ts';
import { makeTestApp } from '../test/harness.ts';

// ===========================================================================
// Phase gate — instance AI config in __system. One scenario exercises the whole
// chain: an instance key resolved by (provider, label) with no workspace tie,
// the admin-gated route, secret-never-leaks (M2), and metering attribution.
// ===========================================================================

type TestDB = Awaited<ReturnType<typeof makeTestApp>>['db'];

const AI_KEYS_PATH = '/api/v1/instance/ai-keys';
const SECRET = 'sk-INSTANCE-must-never-leak-into-messages';

async function seedRunsTable(db: TestDB, projectId: string): Promise<TableEntity> {
  const id = nanoid();
  await db.insert(tables).values({ id, projectId, slug: 'runs', name: 'Runs' });
  return (await db.query.tables.findFirst({ where: eq(tables.id, id) }))!;
}

async function getWorkItemsTable(db: TestDB, projectId: string): Promise<TableEntity> {
  return (await db.query.tables.findFirst({
    where: and(eq(tables.projectId, projectId), eq(tables.slug, 'work-items')),
  }))!;
}

async function seedWorkItem(
  db: TestDB,
  workspace: Workspace,
  project: Project,
  table: TableEntity,
  user: User,
): Promise<Document> {
  const id = nanoid();
  await db.insert(documents).values({
    id,
    workspaceId: workspace.id,
    projectId: project.id,
    tableId: table.id,
    type: 'work_item',
    slug: `wi-${nanoid(6)}`,
    title: 'Parent WI',
    status: null,
    body: '',
    frontmatter: {},
    createdBy: user.id,
    updatedBy: user.id,
  });
  return (await db.query.documents.findFirst({ where: eq(documents.id, id) }))!;
}

/** Seed a local agent in workspace B with provider=ollama + ai_key_label. */
async function seedOllamaAgent(
  db: TestDB,
  workspace: Workspace,
  user: User,
  label: string,
): Promise<Document> {
  const id = nanoid();
  const { hash } = newApiToken();
  const apiTokenId = nanoid();
  await db.insert(documents).values({
    id,
    workspaceId: workspace.id,
    projectId: null,
    tableId: null,
    type: 'agent',
    slug: 'b-worker',
    title: 'b-worker',
    status: null,
    body: 'You are a worker.',
    frontmatter: {
      model: 'qwen2.5-coder:7b',
      provider: 'ollama',
      ai_key_label: label,
      tools: ['list_documents'],
      projects: ['*'],
      max_delegation_depth: 2,
      max_tokens_per_run: 10_000,
      requires_approval: false,
      api_token_id: apiTokenId,
    },
    createdBy: user.id,
    updatedBy: user.id,
  });
  await db.insert(apiTokens).values({
    id: apiTokenId,
    workspaceId: workspace.id,
    name: 'agent:b-worker',
    tokenHash: hash,
    scopes: toolsToScopes(['list_documents']),
    agentId: id,
    createdBy: user.id,
  });
  return (await db.query.documents.findFirst({ where: eq(documents.id, id) }))!;
}

describe('phase gate — instance AI config (cross-cutting)', () => {
  test('an instance key resolves by (provider,label) with no workspace tie; admin-gated; secret never leaks; metered', async () => {
    const harness = await makeTestApp();
    const { app, db, seed } = harness;
    await bootstrapSystemWorkspace(db);
    await grantOwner(db, seed.user.email); // seed.user becomes the __system admin

    // --- create the instance key over real HTTP, as the __system admin ---
    const createRes = await app.request(AI_KEYS_PATH, {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'ollama',
        apiKey: SECRET,
        label: 'default',
        baseUrl: 'https://ollama.example.com',
      }),
    });
    expect(createRes.status).toBe(201);

    // The key row carries NO workspace tie.
    const keyRows = await db.query.aiKeys.findMany();
    expect(keyRows.length).toBe(1);
    expect('workspaceId' in keyRows[0]!).toBe(false);
    expect(decryptSecret(keyRows[0]!.encryptedKey)).toBe(SECRET);

    // --- GET (admin) returns metadata, never the secret ---
    const listRes = await app.request(AI_KEYS_PATH, { headers: { Cookie: seed.sessionCookie } });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.data.keys.length).toBe(1);
    expect(JSON.stringify(listBody)).not.toContain(SECRET);
    expect(listBody.data.keys[0].encryptedKey).toBeUndefined();

    // --- build a run in workspace B (seed.workspace) whose agent pins
    //     (provider=ollama, ai_key_label=default). B has NO workspace-scoped key
    //     (keys are instance-level), so resolution MUST be by (provider,label). ---
    const wiTable = await getWorkItemsTable(db, seed.project.id);
    const parent = await seedWorkItem(db, seed.workspace, seed.project, wiTable, seed.user);
    const runsTable = await seedRunsTable(db, seed.project.id);
    const agent = await seedOllamaAgent(db, seed.workspace, seed.user, 'default');
    const { document: runDoc } = await createRun({
      workspace: seed.workspace,
      project: seed.project,
      runsTable,
      agent,
      actor: seed.user,
      input: {
        parentDocumentId: parent.id,
        firedBy: 'agent.task.assigned',
        chainId: crypto.randomUUID(),
        triggerId: null,
      },
    });

    const ctx = await loadContext(runDoc.id);
    expect(ctx).not.toBeNull();
    // Resolved by (provider, label), NOT by run.workspaceId.
    expect(ctx!.apiKey).toBe(SECRET);
    expect(ctx!.baseUrl).toBe('https://ollama.example.com');

    // --- M2 (load-bearing): the decrypted secret must NOT appear anywhere in the
    //     serialized run context EXCEPT the dedicated apiKey field (which is
    //     injected into the provider call only, never into messages/prompt). ---
    const { apiKey: _omitSecret, ...ctxWithoutKey } = ctx!;
    expect(JSON.stringify(ctxWithoutKey)).not.toContain(SECRET);

    // --- metering (M8): the RUN DOCUMENT is the meter. It carries workspace_id +
    //     provider + ai_key_label + tokens_in/out (the latter written by
    //     incrementTokens on every path), so usage is attributable to the run's
    //     workspace by aggregating runs — no separate ai_usage table. Assert the
    //     run doc carries the attribution fields a "spend per workspace" view reads. ---
    const persisted = (await db.query.documents.findFirst({
      where: eq(documents.id, runDoc.id),
    }))!;
    expect(persisted.workspaceId).toBe(runDoc.workspaceId); // attributable to B
    const persistedFm = persisted.frontmatter as {
      provider: string;
      ai_key_label: string;
      tokens_in: number;
      tokens_out: number;
    };
    expect(persistedFm.provider).toBe('ollama');
    expect(persistedFm.ai_key_label).toBe('default');
    expect(typeof persistedFm.tokens_in).toBe('number'); // the meter field
    expect(typeof persistedFm.tokens_out).toBe('number');
  });

  test('a non-__system session is forbidden on GET /instance/ai-keys (M4)', async () => {
    const harness = await makeTestApp();
    const { app, db, seed } = harness;
    await bootstrapSystemWorkspace(db); // do NOT grantOwner — seed.user is not an instance admin
    const res = await app.request(AI_KEYS_PATH, { headers: { Cookie: seed.sessionCookie } });
    expect(res.status).toBe(403);
  });
});
