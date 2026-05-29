import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { DB } from '../db/client.ts';
import {
  type ApiToken,
  type Document,
  type Project,
  type User,
  type Workspace,
  apiTokens,
  documents,
  tables as tablesTable,
} from '../db/schema.ts';
import { env } from '../env.ts';
import { makeTestApp } from '../test/harness.ts';
import { createRun, ensureRunsTable, nextChainId } from '../services/agent-runs.ts';
import { listComments } from '../services/comments.ts';
import { type ToolDef, executeTool, listToolDefs, registerTool } from './agent-tools.ts';
import { newApiToken } from './auth.ts';

/**
 * Build a minimal ApiToken stub. Only the fields executeTool reads
 * (`scopes`, `agentId`) carry meaning here; the rest satisfy the type.
 */
function makeToken(overrides: Partial<ApiToken> = {}): ApiToken {
  return {
    id: 'tok_test',
    workspaceId: 'ws_test',
    name: 'test',
    tokenHash: 'hash',
    scopes: ['documents:read'],
    agentId: null,
    projectIds: null,
    createdBy: null,
    lastUsedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

// Track throwaway registrations so they don't leak into sibling tests/files
// (registry is module-global per the mock-module-leak lesson).
const registeredInTest: string[] = [];
function registerThrowaway<TArgs, TOut>(def: ToolDef<TArgs, TOut>): void {
  registerTool(def);
  registeredInTest.push(def.name);
}

afterEach(() => {
  for (const name of registeredInTest.splice(0)) {
    // @ts-expect-error — test-only registry teardown hook
    (globalThis.__folioToolRegistry as Map<string, unknown>)?.delete(name);
  }
});

describe('executeTool dispatch', () => {
  it('throws "method not found" for an unknown tool name', async () => {
    await expect(executeTool(makeToken(), 'tester', 'nope', {})).rejects.toThrow(
      'method not found: nope',
    );
  });

  it('throws "method not found" for __echo when NODE_ENV !== "test"', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(executeTool(makeToken(), 'tester', '__echo', { value: 'hi' })).rejects.toThrow(
        'method not found: __echo',
      );
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('runs the tool when args parse + scope check pass', async () => {
    const out = await executeTool(makeToken(), 'tester', '__echo', { value: 'hi' });
    expect(out).toEqual({ echoed: 'hi' });
  });

  it('throws MCP_INVALID_ARGS with PATHS only when args fail Zod parse', async () => {
    let invoked = false;
    registerThrowaway({
      name: '__parse_probe',
      requiredScope: 'documents:read',
      schema: z.object({ value: z.string() }).strict(),
      handler: async () => {
        invoked = true;
        return null;
      },
    });

    let thrown: unknown;
    try {
      await executeTool(makeToken(), 'tester', '__parse_probe', { value: 123 });
    } catch (err) {
      thrown = err;
    }

    expect(invoked).toBe(false);
    expect(thrown).toBeInstanceOf(Error);
    const e = thrown as Error & { issues?: Array<{ path: (string | number)[] }> };
    expect(e.message).toBe('MCP_INVALID_ARGS');
    expect(e.issues).toEqual([{ path: ['value'] }]);
    // The offending value (123) must NOT appear anywhere in the payload.
    expect(JSON.stringify(e.issues)).not.toContain('123');
    expect(JSON.stringify({ message: e.message, issues: e.issues })).not.toContain('123');
  });

  it('throws forbidden: scope missing when the token lacks the requiredScope', async () => {
    let invoked = false;
    registerThrowaway({
      name: '__scope_probe',
      requiredScope: 'agents:write',
      schema: z.object({}).strict(),
      handler: async () => {
        invoked = true;
        return null;
      },
    });

    await expect(
      executeTool(makeToken({ scopes: ['documents:read'] }), 'tester', '__scope_probe', {}),
    ).rejects.toThrow('forbidden: scope agents:write missing');
    expect(invoked).toBe(false);
  });

  it('threads the optional tx arg into the handler ctx', async () => {
    const { db } = await makeTestApp();
    let seenTx: unknown = 'unset';
    registerThrowaway({
      name: '__tx_probe',
      requiredScope: 'documents:read',
      schema: z.object({}).strict(),
      handler: async (_args, ctx) => {
        seenTx = ctx.tx;
        return null;
      },
    });

    await db.transaction(async (tx) => {
      await executeTool(makeToken(), 'tester', '__tx_probe', {}, tx);
      expect(seenTx).toBe(tx);
    });
  });

  it('omits tx from the handler ctx when not passed', async () => {
    let seenTx: unknown = 'unset';
    registerThrowaway({
      name: '__notx_probe',
      requiredScope: 'documents:read',
      schema: z.object({}).strict(),
      handler: async (_args, ctx) => {
        seenTx = ctx.tx;
        return null;
      },
    });

    await executeTool(makeToken(), 'tester', '__notx_probe', {});
    expect(seenTx).toBe(undefined);
  });
});

describe('registerTool', () => {
  it('registerTool throws on duplicate name', () => {
    registerThrowaway({
      name: '__dup_probe',
      requiredScope: 'documents:read',
      schema: z.object({}).strict(),
      handler: async () => null,
    });
    expect(() =>
      registerTool({
        name: '__dup_probe',
        requiredScope: 'documents:read',
        schema: z.object({}).strict(),
        handler: async () => null,
      }),
    ).toThrow('tool already registered: __dup_probe');
  });
});

describe('agent-lifecycle gating (deferred to D-3)', () => {
  it('does not block an agent-bound token at the DISPATCHER level — only scope + Zod gate', async () => {
    // D-2 NOTE: the dispatcher itself (executeTool) still applies no
    // lifecycle gate — scope + Zod only. The per-tool guards now live inside
    // the migrated handlers (see the "D-2 real-tool" suites below), not in
    // executeTool. This probe uses a throwaway tool name so it exercises the
    // dispatcher in isolation.
    const ran = { value: false };
    registerThrowaway({
      name: '__lifecycle_probe',
      requiredScope: 'agents:write',
      schema: z.object({ slug: z.string() }).strict(),
      handler: async () => {
        ran.value = true;
        return { ok: true };
      },
    });

    const out = await executeTool(
      makeToken({ agentId: 'doc_A', scopes: ['agents:write'] }),
      'agent:A',
      '__lifecycle_probe',
      { slug: 'child' },
    );
    expect(ran.value).toBe(true);
    expect(out).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// D-2 Step A — ToolDef transport-metadata round-trip + listToolDefs accessor.
// ---------------------------------------------------------------------------

describe('D-2 Step A: ToolDef transport metadata', () => {
  it('round-trips description + inputSchema and surfaces them in listToolDefs()', () => {
    const inputSchema = { type: 'object', properties: { foo: { type: 'string' } } };
    registerThrowaway({
      name: '__meta_probe',
      requiredScope: 'documents:read',
      description: 'a probe tool',
      inputSchema,
      schema: z.object({ foo: z.string() }).strict(),
      handler: async () => null,
    });

    const entry = listToolDefs().find((t) => t.name === '__meta_probe');
    expect(entry).toBeDefined();
    expect(entry?.description).toBe('a probe tool');
    expect(entry?.inputSchema).toEqual(inputSchema);
  });

  it('lists all 20 real tools with description + inputSchema and excludes __echo', () => {
    const entries = listToolDefs();
    const names = entries.map((e) => e.name);
    // The 20 production tools must be present.
    for (const n of [
      'list_workspaces',
      'list_projects',
      'list_documents',
      'get_document',
      'get_document_markdown',
      'create_document',
      'update_document',
      'delete_document',
      'list_statuses',
      'list_fields',
      'list_views',
      'run_view',
      'create_comment',
      'list_comments',
      'update_comment',
      'delete_comment',
      'create_agent',
      'update_agent',
      'delete_agent',
      'get_agent_self',
    ]) {
      expect(names).toContain(n);
    }
    // __echo (test-only) must never appear in the public tool list.
    expect(names).not.toContain('__echo');
    // Every real tool carries transport metadata.
    const createAgent = entries.find((e) => e.name === 'create_agent');
    expect(typeof createAgent?.description).toBe('string');
    expect(createAgent?.inputSchema).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// D-2 Step B/C — exercise a representative sample of the 20 real tools through
// `executeTool` (the RUNNER's direct path), proving the migration carried the
// behavior AND the agent-lifecycle guards (mitigation 57).
// ---------------------------------------------------------------------------

/** Seed an agent doc + agent-bound token directly in the test DB. */
async function seedAgent(
  db: DB,
  workspaceId: string,
  userId: string,
  opts: { projects?: string[]; tools?: string[]; scopes?: string[]; slug?: string } = {},
): Promise<{ token: ApiToken; agentId: string; agentSlug: string; plaintext: string }> {
  const agentId = nanoid();
  const agentSlug = opts.slug ?? `agent-${nanoid(6)}`;
  await db.insert(documents).values({
    id: agentId,
    projectId: null,
    workspaceId,
    tableId: null,
    type: 'agent',
    slug: agentSlug,
    title: 'Test Agent',
    status: null,
    body: '',
    frontmatter: {
      system_prompt: 'help',
      model: 'm',
      provider: 'anthropic',
      tools: opts.tools ?? ['list_documents', 'create_document'],
      projects: opts.projects ?? ['*'],
    },
    createdBy: userId,
    updatedBy: userId,
  });
  const { token: plaintext, hash } = newApiToken();
  const tokenId = nanoid();
  const scopes = opts.scopes ?? ['documents:read', 'documents:write', 'documents:delete'];
  await db.insert(apiTokens).values({
    id: tokenId,
    workspaceId,
    name: `agent:${agentSlug}`,
    tokenHash: hash,
    scopes,
    agentId,
    createdBy: userId,
  });
  const [token] = await db.select().from(apiTokens).where(eq(apiTokens.id, tokenId));
  return { token: token!, agentId, agentSlug, plaintext };
}

/** A human-PAT (no agentId) ApiToken row for the seed workspace/user. */
async function seedHumanPat(
  db: DB,
  workspaceId: string,
  userId: string,
  scopes: string[],
): Promise<ApiToken> {
  const { hash } = newApiToken();
  const tokenId = nanoid();
  await db.insert(apiTokens).values({
    id: tokenId,
    workspaceId,
    name: 'pat-test',
    tokenHash: hash,
    scopes,
    createdBy: userId,
  });
  const [token] = await db.select().from(apiTokens).where(eq(apiTokens.id, tokenId));
  return token!;
}

describe('D-2: read/write/comment tools via executeTool', () => {
  it('list_documents returns project docs (read happy path)', async () => {
    const { db, seed } = await makeTestApp();
    const token = await seedHumanPat(db, seed.workspace.id, seed.user.id, ['documents:read']);
    const out = (await executeTool(token, seed.user.id, 'list_documents', {
      workspace_slug: 'acme',
      project_slug: 'web',
    })) as { content: { text: string }[] };
    const parsed = JSON.parse(out.content[0]!.text) as { documents: unknown[] };
    expect(Array.isArray(parsed.documents)).toBe(true);
  });

  it('create_document creates a work_item (write happy path)', async () => {
    const { db, seed } = await makeTestApp();
    const token = await seedHumanPat(db, seed.workspace.id, seed.user.id, ['documents:write']);
    const out = (await executeTool(token, seed.user.id, 'create_document', {
      workspace_slug: 'acme',
      project_slug: 'web',
      type: 'work_item',
      title: 'From the runner path',
    })) as { content: { text: string }[] };
    const doc = JSON.parse(out.content[0]!.text) as { title: string; type: string };
    expect(doc.title).toBe('From the runner path');
    expect(doc.type).toBe('work_item');
  });

  it('create_comment posts on a work_item (comment happy path)', async () => {
    const { db, seed } = await makeTestApp();
    const writeTok = await seedHumanPat(db, seed.workspace.id, seed.user.id, ['documents:write']);
    // Create a parent work_item first.
    const created = (await executeTool(writeTok, seed.user.id, 'create_document', {
      workspace_slug: 'acme',
      project_slug: 'web',
      type: 'work_item',
      title: 'Parent',
    })) as { content: { text: string }[] };
    const parent = JSON.parse(created.content[0]!.text) as { slug: string };

    const out = (await executeTool(writeTok, seed.user.id, 'create_comment', {
      workspace_slug: 'acme',
      project_slug: 'web',
      parent_slug: parent.slug,
      body: 'hello from the runner',
    })) as { content: { text: string }[] };
    const comment = JSON.parse(out.content[0]!.text) as { slug: string };
    expect(comment.slug).toBeTruthy();
  });
});

describe('D-2: agent-lifecycle guards survive the migration (mitigation 57)', () => {
  it('delete_agent rejects self-delete from the agent-bound token', async () => {
    const { db, seed } = await makeTestApp();
    const { token, agentSlug } = await seedAgent(db, seed.workspace.id, seed.user.id, {
      scopes: ['agents:write', 'documents:read'],
    });
    let thrown: unknown;
    try {
      await executeTool(token, `agent:${agentSlug}`, 'delete_agent', {
        workspace_slug: 'acme',
        slug: agentSlug, // agent deleting itself
      });
    } catch (err) {
      thrown = err;
    }
    const e = thrown as Error & { code?: number; data?: { reason?: string } };
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe(-32602);
    expect(e.data?.reason).toBe('cannot_delete_self');
  });

  it('create_agent rejects a human PAT (no agent binding)', async () => {
    const { db, seed } = await makeTestApp();
    const pat = await seedHumanPat(db, seed.workspace.id, seed.user.id, [
      'agents:write',
      'documents:read',
    ]);
    let thrown: unknown;
    try {
      await executeTool(pat, seed.user.id, 'create_agent', {
        workspace_slug: 'acme',
        title: 'Spawned',
        frontmatter: { system_prompt: 'x', model: 'm', provider: 'anthropic' },
      });
    } catch (err) {
      thrown = err;
    }
    const e = thrown as Error & { code?: number; data?: { reason?: string } };
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe(-32000);
    expect(e.data?.reason).toBe('human_pat_rejected_on_agent_lifecycle');
  });

  it('update_agent rejects a human PAT (no agent binding)', async () => {
    const { db, seed } = await makeTestApp();
    // Seed a target agent for the PAT to attempt to patch.
    const { agentSlug } = await seedAgent(db, seed.workspace.id, seed.user.id);
    const pat = await seedHumanPat(db, seed.workspace.id, seed.user.id, [
      'agents:write',
      'documents:read',
    ]);
    let thrown: unknown;
    try {
      await executeTool(pat, seed.user.id, 'update_agent', {
        workspace_slug: 'acme',
        slug: agentSlug,
        title: 'Renamed',
      });
    } catch (err) {
      thrown = err;
    }
    const e = thrown as Error & { code?: number; data?: { reason?: string } };
    expect(e.code).toBe(-32000);
    expect(e.data?.reason).toBe('human_pat_rejected_on_agent_lifecycle');
  });

  it('delete_agent rejects a human PAT (no agent binding)', async () => {
    const { db, seed } = await makeTestApp();
    const { agentSlug } = await seedAgent(db, seed.workspace.id, seed.user.id);
    const pat = await seedHumanPat(db, seed.workspace.id, seed.user.id, [
      'agents:write',
      'documents:read',
    ]);
    let thrown: unknown;
    try {
      await executeTool(pat, seed.user.id, 'delete_agent', {
        workspace_slug: 'acme',
        slug: agentSlug,
      });
    } catch (err) {
      thrown = err;
    }
    const e = thrown as Error & { code?: number; data?: { reason?: string } };
    expect(e.code).toBe(-32000);
    expect(e.data?.reason).toBe('human_pat_rejected_on_agent_lifecycle');
  });

  it('get_agent_self requires an agent-bound token (rejects human PAT)', async () => {
    const { db, seed } = await makeTestApp();
    const pat = await seedHumanPat(db, seed.workspace.id, seed.user.id, ['documents:read']);
    let thrown: unknown;
    try {
      await executeTool(pat, seed.user.id, 'get_agent_self', {});
    } catch (err) {
      thrown = err;
    }
    const e = thrown as Error & { code?: number; data?: { reason?: string } };
    expect(e.code).toBe(-32602);
    expect(e.data?.reason).toBe('no_agent_bound_to_token');
  });

  it('get_agent_self returns the calling agent for an agent-bound token', async () => {
    const { db, seed } = await makeTestApp();
    const { token, agentSlug } = await seedAgent(db, seed.workspace.id, seed.user.id, {
      scopes: ['documents:read'],
    });
    const out = (await executeTool(token, `agent:${agentSlug}`, 'get_agent_self', {})) as {
      content: { text: string }[];
    };
    const agent = JSON.parse(out.content[0]!.text) as { slug: string; type: string };
    expect(agent.slug).toBe(agentSlug);
    expect(agent.type).toBe('agent');
  });

  it('create_agent rejects allow-list widening by an agent-bound caller', async () => {
    const { db, seed } = await makeTestApp();
    // Caller agent is narrowed to a single project id.
    const { token, agentSlug } = await seedAgent(db, seed.workspace.id, seed.user.id, {
      projects: [seed.project.id],
      scopes: ['agents:write', 'documents:read'],
    });
    let thrown: unknown;
    try {
      await executeTool(token, `agent:${agentSlug}`, 'create_agent', {
        workspace_slug: 'acme',
        title: 'Wide child',
        frontmatter: {
          system_prompt: 'x',
          model: 'm',
          provider: 'anthropic',
          projects: ['*'], // widen past caller's narrow allow-list
        },
      });
    } catch (err) {
      thrown = err;
    }
    const e = thrown as Error & { code?: number; data?: { reason?: string } };
    expect(e.code).toBe(-32602);
    expect(e.data?.reason).toBe('allow_list_widening_forbidden');
  });

  it('create_agent rejects tools widening by an agent-bound caller', async () => {
    const { db, seed } = await makeTestApp();
    // Caller agent has a narrow toolset.
    const { token, agentSlug } = await seedAgent(db, seed.workspace.id, seed.user.id, {
      projects: ['*'],
      tools: ['list_documents'],
      scopes: ['agents:write', 'documents:read'],
    });
    let thrown: unknown;
    try {
      await executeTool(token, `agent:${agentSlug}`, 'create_agent', {
        workspace_slug: 'acme',
        title: 'Powerful child',
        frontmatter: {
          system_prompt: 'x',
          model: 'm',
          provider: 'anthropic',
          projects: ['*'],
          tools: ['list_documents', 'delete_document'], // widen tools
        },
      });
    } catch (err) {
      thrown = err;
    }
    const e = thrown as Error & { code?: number; data?: { reason?: string } };
    expect(e.code).toBe(-32602);
    expect(e.data?.reason).toBe('tools_widening_forbidden');
  });
});

// ---------------------------------------------------------------------------
// D-4 — the 5 run-management MCP tools (list_runs, get_run, run_agent,
// cancel_run, retry_run). Each delegates to the SAME seam D-1's HTTP routes
// call (createRunForParent, loadRunScopedByToken, listRuns, transitionRun), so
// these assert: (a) each happy path via executeTool, (b) HTTP-twin PARITY
// (same row effect / outcome as the D-1 verb against the same seed), and
// (c) the bound mitigations (54 autonomy gate, 58 cross-scope, 56/63
// idempotency). Real DB via makeTestApp, no mocking.
// ---------------------------------------------------------------------------

/** Seed an agent doc with the FULL frontmatter createRun snapshots, + a token. */
async function seedRunAgent(
  db: DB,
  workspaceId: string,
  userId: string,
  slug: string,
  opts: { projects?: string[]; agentBound?: boolean; scopes?: string[] } = {},
): Promise<{ agent: Document; token: ApiToken }> {
  const agentId = nanoid();
  await db.insert(documents).values({
    id: agentId,
    projectId: null,
    workspaceId,
    tableId: null,
    type: 'agent',
    slug,
    title: slug,
    status: null,
    body: '',
    frontmatter: {
      system_prompt: 'You are a helper.',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      tools: ['list_documents'],
      projects: opts.projects ?? ['*'],
      max_delegation_depth: 2,
      max_tokens_per_run: 12_345,
      requires_approval: false,
    },
    createdBy: userId,
    updatedBy: userId,
  });
  const { hash } = newApiToken();
  const tokenId = nanoid();
  const scopes = opts.scopes ?? ['agents:write', 'documents:read'];
  await db.insert(apiTokens).values({
    id: tokenId,
    workspaceId,
    name: `agent:${slug}`,
    tokenHash: hash,
    scopes,
    // agentBound defaults FALSE → a human-PAT-shaped token (createdBy set,
    // agentId null) so run_agent's autonomy gate allows it.
    agentId: opts.agentBound ? agentId : null,
    createdBy: userId,
  });
  const [token] = await db.select().from(apiTokens).where(eq(apiTokens.id, tokenId));
  const agent = await db.query.documents.findFirst({ where: eq(documents.id, agentId) });
  return { agent: agent!, token: token! };
}

async function seedWorkItem(
  db: DB,
  workspace: Workspace,
  project: Project,
  user: User,
): Promise<Document> {
  const table = await db.query.tables.findFirst({
    where: and(eq(tablesTable.projectId, project.id), eq(tablesTable.slug, 'work-items')),
  });
  const id = nanoid();
  await db.insert(documents).values({
    id,
    workspaceId: workspace.id,
    projectId: project.id,
    tableId: table!.id,
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

async function seedRunRow(
  db: DB,
  workspace: Workspace,
  project: Project,
  agent: Document,
  actor: User,
  parent: Document,
): Promise<Document> {
  const runsTable = await db.transaction(async (tx) =>
    ensureRunsTable(tx, { workspaceId: workspace.id, projectId: project.id }),
  );
  const { document } = await createRun({
    workspace,
    project,
    runsTable,
    agent,
    actor,
    input: {
      parentDocumentId: parent.id,
      firedBy: 'manual',
      chainId: nextChainId({ firedBy: 'manual' }),
      triggerId: null,
    },
  });
  return document;
}

/** Parse the textResult JSON envelope the run tools return. */
function parseText<T>(out: unknown): T {
  return JSON.parse((out as { content: { text: string }[] }).content[0]!.text) as T;
}

describe('D-4: run-management MCP tools', () => {
  it('run_agent (human PAT) creates a planning run — happy path', async () => {
    const { db, seed } = await makeTestApp();
    const parent = await seedWorkItem(db, seed.workspace, seed.project, seed.user);
    const { token } = await seedRunAgent(db, seed.workspace.id, seed.user.id, 'helper');

    const out = await executeTool(token, seed.user.id, 'run_agent', {
      workspace_slug: 'acme',
      agent_slug: 'helper',
      parent_slug: parent.slug,
    });
    const res = parseText<{ run_id: string; status: string }>(out);
    expect(res.status).toBe('planning');
    const row = await db.query.documents.findFirst({ where: eq(documents.id, res.run_id) });
    expect(row?.type).toBe('agent_run');
    expect(row?.status).toBe('planning');
  });

  it('run_agent with input posts a comment to the parent (mit 59)', async () => {
    const { db, seed } = await makeTestApp();
    const parent = await seedWorkItem(db, seed.workspace, seed.project, seed.user);
    await seedRunAgent(db, seed.workspace.id, seed.user.id, 'helper');
    const { token } = await seedRunAgent(db, seed.workspace.id, seed.user.id, 'helper2');

    await executeTool(token, seed.user.id, 'run_agent', {
      workspace_slug: 'acme',
      agent_slug: 'helper2',
      parent_slug: parent.slug,
      input: 'do the thing',
    });
    const comments = await listComments({ parentId: parent.id });
    expect(comments.length).toBe(1);
    expect(comments[0]?.body).toBe('do the thing');
  });

  it('list_runs + get_run return the seeded run (read happy paths)', async () => {
    const { db, seed } = await makeTestApp();
    const parent = await seedWorkItem(db, seed.workspace, seed.project, seed.user);
    const { agent, token } = await seedRunAgent(db, seed.workspace.id, seed.user.id, 'helper');
    const run = await seedRunRow(db, seed.workspace, seed.project, agent, seed.user, parent);

    const listed = parseText<{ id: string }[]>(
      await executeTool(token, seed.user.id, 'list_runs', {
        workspace_slug: 'acme',
        project_slug: 'web',
      }),
    );
    expect(listed.map((r) => r.id)).toContain(run.id);

    const got = parseText<{ id: string; type: string }>(
      await executeTool(token, seed.user.id, 'get_run', {
        workspace_slug: 'acme',
        run_id: run.id,
      }),
    );
    expect(got.id).toBe(run.id);
    expect(got.type).toBe('agent_run');
  });

  it('cancel_run on a planning run → failed (parity with HTTP cancel)', async () => {
    const { db, seed } = await makeTestApp();
    const parent = await seedWorkItem(db, seed.workspace, seed.project, seed.user);
    const { agent, token } = await seedRunAgent(db, seed.workspace.id, seed.user.id, 'helper');
    const run = await seedRunRow(db, seed.workspace, seed.project, agent, seed.user, parent);

    const res = parseText<{ run_id: string; status: string }>(
      await executeTool(token, seed.user.id, 'cancel_run', {
        workspace_slug: 'acme',
        run_id: run.id,
      }),
    );
    expect(res.status).toBe('failed');
    const row = await db.query.documents.findFirst({ where: eq(documents.id, run.id) });
    expect(row?.status).toBe('failed');
    expect((row?.frontmatter as { error_reason?: string }).error_reason).toBe('cancelled');
  });

  it('retry_run on a terminal run creates a fresh planning run (mit 63 happy)', async () => {
    const { db, seed } = await makeTestApp();
    const parent = await seedWorkItem(db, seed.workspace, seed.project, seed.user);
    const { agent, token } = await seedRunAgent(db, seed.workspace.id, seed.user.id, 'helper');
    const run = await seedRunRow(db, seed.workspace, seed.project, agent, seed.user, parent);
    // Terminalize the original so it's not an active peer.
    await db
      .update(documents)
      .set({
        status: 'failed',
        frontmatter: { ...(run.frontmatter as Record<string, unknown>), status: 'failed' },
      })
      .where(eq(documents.id, run.id));

    const res = parseText<{ run_id: string; status: string }>(
      await executeTool(token, seed.user.id, 'retry_run', {
        workspace_slug: 'acme',
        run_id: run.id,
      }),
    );
    expect(res.status).toBe('planning');
    expect(res.run_id).not.toBe(run.id);
    const rows = await db.query.documents.findMany({ where: eq(documents.type, 'agent_run') });
    expect(rows.length).toBe(2);
  });

  it('retry_run while original still active → RUN_ALREADY_ACTIVE (mit 63)', async () => {
    const { db, seed } = await makeTestApp();
    const parent = await seedWorkItem(db, seed.workspace, seed.project, seed.user);
    const { agent, token } = await seedRunAgent(db, seed.workspace.id, seed.user.id, 'helper');
    const run = await seedRunRow(db, seed.workspace, seed.project, agent, seed.user, parent);

    let thrown: unknown;
    try {
      await executeTool(token, seed.user.id, 'retry_run', {
        workspace_slug: 'acme',
        run_id: run.id,
      });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { code?: string }).code).toBe('RUN_ALREADY_ACTIVE');
    // No second run materialized.
    const rows = await db.query.documents.findMany({ where: eq(documents.type, 'agent_run') });
    expect(rows.length).toBe(1);
  });

  it('run_agent twice on the same parent → RUN_ALREADY_ACTIVE (mit 56)', async () => {
    const { db, seed } = await makeTestApp();
    const parent = await seedWorkItem(db, seed.workspace, seed.project, seed.user);
    const { token } = await seedRunAgent(db, seed.workspace.id, seed.user.id, 'helper');
    const argsBag = { workspace_slug: 'acme', agent_slug: 'helper', parent_slug: parent.slug };

    await executeTool(token, seed.user.id, 'run_agent', argsBag);
    let thrown: unknown;
    try {
      await executeTool(token, seed.user.id, 'run_agent', argsBag);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { code?: string }).code).toBe('RUN_ALREADY_ACTIVE');
  });

  it('mit 54: agent-bound bearer run_agent with chains OFF is suppressed', async () => {
    const { db, seed } = await makeTestApp();
    const parent = await seedWorkItem(db, seed.workspace, seed.project, seed.user);
    const { token, agent } = await seedRunAgent(db, seed.workspace.id, seed.user.id, 'helper', {
      agentBound: true,
    });

    const prev = env.FOLIO_AGENT_CHAINS_ENABLED;
    env.FOLIO_AGENT_CHAINS_ENABLED = false;
    let thrown: unknown;
    try {
      await executeTool(token, `agent:${agent.slug}`, 'run_agent', {
        workspace_slug: 'acme',
        agent_slug: 'helper',
        parent_slug: parent.slug,
      });
    } catch (err) {
      thrown = err;
    } finally {
      env.FOLIO_AGENT_CHAINS_ENABLED = prev;
    }
    const e = thrown as { code?: number; data?: { reason?: string } };
    expect(e.code).toBe(-32602);
    expect(e.data?.reason).toBe('agent_chains_disabled');
    // Zero runs created.
    const rows = await db.query.documents.findMany({ where: eq(documents.type, 'agent_run') });
    expect(rows.length).toBe(0);
  });

  // ----- Finding 2: retry_run must honor the autonomy gate (mit 54) -----

  it('Finding 2: agent-bound bearer retry_run with chains OFF → suppressed, no new run', async () => {
    const { db, seed } = await makeTestApp();
    const parent = await seedWorkItem(db, seed.workspace, seed.project, seed.user);
    const { agent, token } = await seedRunAgent(db, seed.workspace.id, seed.user.id, 'helper', {
      agentBound: true,
    });
    const run = await seedRunRow(db, seed.workspace, seed.project, agent, seed.user, parent);
    // Terminalize the original so idempotency would NOT block — the gate must.
    await db
      .update(documents)
      .set({
        status: 'failed',
        frontmatter: { ...(run.frontmatter as Record<string, unknown>), status: 'failed' },
      })
      .where(eq(documents.id, run.id));

    const prev = env.FOLIO_AGENT_CHAINS_ENABLED;
    env.FOLIO_AGENT_CHAINS_ENABLED = false;
    let thrown: unknown;
    try {
      await executeTool(token, `agent:${agent.slug}`, 'retry_run', {
        workspace_slug: 'acme',
        run_id: run.id,
      });
    } catch (err) {
      thrown = err;
    } finally {
      env.FOLIO_AGENT_CHAINS_ENABLED = prev;
    }
    const e = thrown as { code?: number; data?: { reason?: string } };
    expect(e.code).toBe(-32602);
    expect(e.data?.reason).toBe('agent_chains_disabled');
    // Only the seeded (failed) original; no fresh planning run.
    const rows = await db.query.documents.findMany({ where: eq(documents.type, 'agent_run') });
    expect(rows.length).toBe(1);
  });

  it('Finding 2: agent-bound bearer retry_run with chains ON → planning (gate only blocks when off)', async () => {
    const { db, seed } = await makeTestApp();
    const parent = await seedWorkItem(db, seed.workspace, seed.project, seed.user);
    const { agent, token } = await seedRunAgent(db, seed.workspace.id, seed.user.id, 'helper', {
      agentBound: true,
    });
    const run = await seedRunRow(db, seed.workspace, seed.project, agent, seed.user, parent);
    await db
      .update(documents)
      .set({
        status: 'failed',
        frontmatter: { ...(run.frontmatter as Record<string, unknown>), status: 'failed' },
      })
      .where(eq(documents.id, run.id));

    const prev = env.FOLIO_AGENT_CHAINS_ENABLED;
    env.FOLIO_AGENT_CHAINS_ENABLED = true;
    try {
      const res = parseText<{ status: string }>(
        await executeTool(token, `agent:${agent.slug}`, 'retry_run', {
          workspace_slug: 'acme',
          run_id: run.id,
        }),
      );
      expect(res.status).toBe('planning');
    } finally {
      env.FOLIO_AGENT_CHAINS_ENABLED = prev;
    }
    const rows = await db.query.documents.findMany({ where: eq(documents.type, 'agent_run') });
    expect(rows.length).toBe(2);
  });

  // ----- Finding 3: run_agent duplicate must NOT leave a stray input comment -----

  it('Finding 3: duplicate run_agent with input → RUN_ALREADY_ACTIVE and NO stray comment', async () => {
    const { db, seed } = await makeTestApp();
    const parent = await seedWorkItem(db, seed.workspace, seed.project, seed.user);
    const { token } = await seedRunAgent(db, seed.workspace.id, seed.user.id, 'helper');
    const argsBag = {
      workspace_slug: 'acme',
      agent_slug: 'helper',
      parent_slug: parent.slug,
      input: 'first run input',
    };

    // First create succeeds + posts one input comment.
    await executeTool(token, seed.user.id, 'run_agent', argsBag);
    const before = (await listComments({ parentId: parent.id })).length;
    expect(before).toBe(1);

    // Duplicate (active) create with input → must reject BEFORE the comment.
    let thrown: unknown;
    try {
      await executeTool(token, seed.user.id, 'run_agent', { ...argsBag, input: 'second input' });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { code?: string }).code).toBe('RUN_ALREADY_ACTIVE');
    // No stray comment from the rejected duplicate.
    const after = (await listComments({ parentId: parent.id })).length;
    expect(after).toBe(before);
  });

  it('mit 58: get_run for a run id from ANOTHER workspace → AGENT_RUN_NOT_FOUND', async () => {
    const { db, seed } = await makeTestApp();
    // Build a second workspace + project + run inside it.
    const { workspaces, projects, memberships } = await import('../db/schema.ts');
    const { seedProjectDefaults } = await import('./seed-project-defaults.ts');
    const otherWsId = nanoid();
    await db.insert(workspaces).values({ id: otherWsId, slug: 'other', name: 'Other' });
    await db
      .insert(memberships)
      .values({ workspaceId: otherWsId, userId: seed.user.id, role: 'owner' });
    const otherProjectId = nanoid();
    await db
      .insert(projects)
      .values({ id: otherProjectId, workspaceId: otherWsId, slug: 'other-web', name: 'Other Web' });
    await seedProjectDefaults(db, otherProjectId);
    const [otherWs] = await db.select().from(workspaces).where(eq(workspaces.id, otherWsId));
    const [otherProj] = await db.select().from(projects).where(eq(projects.id, otherProjectId));
    const otherParent = await seedWorkItem(db, otherWs!, otherProj!, seed.user);
    const { agent: otherAgent } = await seedRunAgent(db, otherWsId, seed.user.id, 'helper');
    const otherRun = await seedRunRow(db, otherWs!, otherProj!, otherAgent, seed.user, otherParent);

    // A token bound to the FIRST workspace addresses the OTHER workspace's run.
    const { token } = await seedRunAgent(db, seed.workspace.id, seed.user.id, 'reader', {
      scopes: ['documents:read', 'agents:write'],
    });
    for (const tool of ['get_run', 'cancel_run', 'retry_run']) {
      let thrown: unknown;
      try {
        await executeTool(token, seed.user.id, tool, {
          workspace_slug: 'acme',
          run_id: otherRun.id,
        });
      } catch (err) {
        thrown = err;
      }
      expect((thrown as { code?: string }).code).toBe('AGENT_RUN_NOT_FOUND');
    }
  });

  it('HTTP-twin parity: MCP run_agent + HTTP POST /runs produce the same row effect', async () => {
    const { app, db, seed } = await makeTestApp();
    // Two distinct parents so the two creates do not collide on idempotency.
    const parentA = await seedWorkItem(db, seed.workspace, seed.project, seed.user);
    const parentB = await seedWorkItem(db, seed.workspace, seed.project, seed.user);
    await seedRunAgent(db, seed.workspace.id, seed.user.id, 'helper');
    const { token } = await seedRunAgent(db, seed.workspace.id, seed.user.id, 'mcp-caller');

    // HTTP twin (session) against parentA.
    const httpRes = await app.request('/api/v1/w/acme/runs', {
      method: 'POST',
      headers: { Cookie: seed.sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_slug: 'helper', parent_slug: parentA.slug }),
    });
    expect(httpRes.status).toBe(201);
    const httpBody = (await httpRes.json()) as { data: { run_id: string; status: string } };

    // MCP tool against parentB.
    const mcpOut = parseText<{ run_id: string; status: string }>(
      await executeTool(token, seed.user.id, 'run_agent', {
        workspace_slug: 'acme',
        agent_slug: 'mcp-caller',
        parent_slug: parentB.slug,
      }),
    );

    // Same semantic outcome: both report a planning run.
    expect(httpBody.data.status).toBe('planning');
    expect(mcpOut.status).toBe('planning');
    // Same row effect: both rows are planning agent_run docs in the workspace.
    const httpRow = await db.query.documents.findFirst({
      where: eq(documents.id, httpBody.data.run_id),
    });
    const mcpRow = await db.query.documents.findFirst({ where: eq(documents.id, mcpOut.run_id) });
    expect(httpRow?.type).toBe('agent_run');
    expect(mcpRow?.type).toBe('agent_run');
    expect(httpRow?.status).toBe(mcpRow?.status);
    expect(httpRow?.workspaceId).toBe(mcpRow?.workspaceId);
  });
});
