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
  events,
  projects,
  tables as tablesTable,
} from '../db/schema.ts';
import { env } from '../env.ts';
import { seedProjectDefaults } from './seed-project-defaults.ts';
import { makeTestApp } from '../test/harness.ts';
import { createRun, ensureRunsTable, nextChainId } from '../services/agent-runs.ts';
import { listComments } from '../services/comments.ts';
import { type ToolDef, executeTool, listToolDefs, registerTool } from './agent-tools.ts';
import {
  SYSTEM_WORKSPACE_SLUG,
  bootstrapSystemWorkspace,
  getSystemWorkspaceId,
  isReservedSlug,
} from './system-workspace.ts';
import { workspaces } from '../db/schema.ts';
import { intersectAgentProjects } from './agent-projects.ts';
import { newApiToken } from './auth.ts';

/**
 * Replicate the central caller-project clamp that `loadContext` (runner.ts)
 * applies before any tool runs: narrow the agent token's project reach to the
 * caller's project set. After the code-review fix the PROJECT half of
 * agent ∩ caller lives in `token.projectIds`, not in a per-tool param — so the
 * delegation tests narrow the token the same way the runner does.
 */
function narrowTokenToCaller(token: ApiToken, callerProjectIds: string[] | null): ApiToken {
  return {
    ...token,
    projectIds: intersectAgentProjects(token.projectIds ?? ['*'], callerProjectIds),
  };
}

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

/**
 * Caller-authority grant for executeTool that mirrors the supplied token's own
 * scopes (the caller is "as authorized as the agent token" — the intent of
 * these pre-delegation tests). Phase 1 delegation (Task 5/6) wires REAL caller
 * values from the runner / MCP route; in unit tests the token IS the authority,
 * so we echo its scopes through the caller param to satisfy the new
 * agent ∩ caller intersect without weakening any test's original assertion.
 */
function callerOf(token: ApiToken): {
  callerScopes: string[];
} {
  return { callerScopes: token.scopes };
}

/** executeTool with a caller mirroring the token's scopes (success-path helper). */
function exec(
  token: ApiToken,
  actor: string,
  name: string,
  args: unknown,
  tx?: Parameters<typeof executeTool>[4],
): Promise<unknown> {
  return executeTool(token, actor, name, args, tx, callerOf(token));
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
    const out = await exec(makeToken(), 'tester', '__echo', { value: 'hi' });
    expect(out).toEqual({ echoed: 'hi' });
  });

  it('caller WITHOUT the required scope → tool denied even though agent token has it', async () => {
    await expect(
      executeTool(makeToken(), 'tester', '__echo', { value: 'x' }, undefined, {
        callerScopes: [],
      }),
    ).rejects.toThrow('forbidden: scope documents:read missing');
  });

  it('caller WITH the required scope → tool runs', async () => {
    const out = await executeTool(makeToken(), 'tester', '__echo', { value: 'x' }, undefined, {
      callerScopes: ['documents:read'],
    });
    expect(out).toEqual({ echoed: 'x' });
  });

  it('undefined caller authority → DENY (fail closed, not fall open)', async () => {
    await expect(executeTool(makeToken(), 'tester', '__echo', { value: 'x' })).rejects.toThrow(
      'forbidden: scope documents:read missing',
    );
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
      await exec(makeToken(), 'tester', '__parse_probe', { value: 123 });
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
      await exec(makeToken(), 'tester', '__tx_probe', {}, tx);
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

    await exec(makeToken(), 'tester', '__notx_probe', {});
    expect(seenTx).toBe(undefined);
  });
});

describe('config:write delegate ceiling (Phase 2 / P2-1, P2-2)', () => {
  // A throwaway tool requiring config:write — proves the ceiling, not behavior.
  function registerConfigProbe() {
    registerThrowaway({
      name: '__config_probe',
      requiredScope: 'config:write',
      schema: z.object({}).strict(),
      handler: async () => ({ ok: true }),
    });
  }

  it('owner-delegated run (agent + caller both hold config:write) → runs', async () => {
    registerConfigProbe();
    const token = makeToken({ scopes: ['config:write', 'documents:read'] });
    const out = await executeTool(token, 'agent:op', '__config_probe', {}, undefined, {
      callerScopes: ['config:write', 'documents:read'],
    });
    expect(out).toEqual({ ok: true });
  });

  it('member-delegated run (caller lacks config:write) → denied, fail closed (P2-1)', async () => {
    registerConfigProbe();
    const token = makeToken({ scopes: ['config:write', 'documents:read'] });
    await expect(
      executeTool(token, 'agent:op', '__config_probe', {}, undefined, {
        callerScopes: ['documents:read', 'documents:write'], // member scopes — no config:write
      }),
    ).rejects.toThrow('forbidden: scope config:write missing');
  });

  it('agent token lacks config:write → denied even if caller has it (P2-2)', async () => {
    registerConfigProbe();
    const token = makeToken({ scopes: ['documents:read'] }); // agent lacks config:write
    await expect(
      executeTool(token, 'agent:op', '__config_probe', {}, undefined, {
        callerScopes: ['config:write'],
      }),
    ).rejects.toThrow('forbidden: scope config:write missing');
  });
});

describe('unattended floor at the convergence point (Phase C C3 review-fix #1)', () => {
  // HIGH-risk NATIVE tools requiring `agents:write` mint/modify standing agent
  // bearer tokens. On an unattended (trigger-fired) run, executeTool must REFUSE
  // them centrally — folio_api only floors its OWN config:write path-tier, so a
  // seedable custom agent declaring a native agents:write tool would otherwise
  // bypass the deterministic bound entirely.

  it('agents:write tool on an UNATTENDED run → refused before dispatch (no handler run)', async () => {
    let invoked = false;
    registerThrowaway({
      name: '__agents_write_probe',
      requiredScope: 'agents:write',
      schema: z.object({}).strict(),
      handler: async () => {
        invoked = true;
        return { ok: true };
      },
    });

    const token = makeToken({ scopes: ['agents:write'] });
    await expect(
      executeTool(token, 'agent:custom', '__agents_write_probe', {}, undefined, {
        callerScopes: ['agents:write'],
        unattended: true,
      }),
    ).rejects.toThrow('forbidden: __agents_write_probe is refused on an unattended');
    expect(invoked).toBe(false);
  });

  it('agents:write tool with unattended FALSEY (attended) → dispatches normally', async () => {
    let invoked = false;
    registerThrowaway({
      name: '__agents_write_probe_attended',
      requiredScope: 'agents:write',
      schema: z.object({}).strict(),
      handler: async () => {
        invoked = true;
        return { ok: true };
      },
    });

    const token = makeToken({ scopes: ['agents:write'] });
    // unattended omitted (undefined) → attended path, unchanged.
    const out = await executeTool(
      token,
      'agent:custom',
      '__agents_write_probe_attended',
      {},
      undefined,
      { callerScopes: ['agents:write'] },
    );
    expect(out).toEqual({ ok: true });
    expect(invoked).toBe(true);

    // explicit unattended: false → also attended.
    invoked = false;
    const out2 = await executeTool(
      token,
      'agent:custom',
      '__agents_write_probe_attended',
      {},
      undefined,
      { callerScopes: ['agents:write'], unattended: false },
    );
    expect(out2).toEqual({ ok: true });
    expect(invoked).toBe(true);
  });

  it('documents:write tool on an UNATTENDED run → STILL dispatches (LOW = accepted residual)', async () => {
    let invoked = false;
    registerThrowaway({
      name: '__doc_write_probe_unattended',
      requiredScope: 'documents:write',
      schema: z.object({}).strict(),
      handler: async () => {
        invoked = true;
        return { ok: true };
      },
    });

    const token = makeToken({ scopes: ['documents:write'] });
    const out = await executeTool(
      token,
      'agent:custom',
      '__doc_write_probe_unattended',
      {},
      undefined,
      { callerScopes: ['documents:write'], unattended: true },
    );
    expect(out).toEqual({ ok: true });
    expect(invoked).toBe(true);
  });

  it('config:write tool on an UNATTENDED run is NOT double-floored by this set (folio_api owns its tier)', async () => {
    // config:write is deliberately absent from UNATTENDED_FLOORED_SCOPES — the
    // convergence floor must not fire for it; folio_api's own MEDIUM path-tier
    // is the single owner of config-write flooring.
    let invoked = false;
    registerThrowaway({
      name: '__config_write_probe_unattended',
      requiredScope: 'config:write',
      schema: z.object({}).strict(),
      handler: async () => {
        invoked = true;
        return { ok: true };
      },
    });

    const token = makeToken({ scopes: ['config:write'] });
    const out = await executeTool(
      token,
      'agent:op',
      '__config_write_probe_unattended',
      {},
      undefined,
      { callerScopes: ['config:write'], unattended: true },
    );
    expect(out).toEqual({ ok: true });
    expect(invoked).toBe(true);
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

    const out = await exec(
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
    // The agent body IS the prompt (snapshot at run-create); createRun rejects
    // an empty body, so seed a non-empty one.
    body: 'help',
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
    const out = (await exec(token, seed.user.id, 'list_documents', {
      workspace_slug: 'acme',
      project_slug: 'web',
    })) as { content: { text: string }[] };
    const parsed = JSON.parse(out.content[0]!.text) as { documents: unknown[] };
    expect(Array.isArray(parsed.documents)).toBe(true);
  });

  it('create_document creates a work_item (write happy path)', async () => {
    const { db, seed } = await makeTestApp();
    const token = await seedHumanPat(db, seed.workspace.id, seed.user.id, ['documents:write']);
    const out = (await exec(token, seed.user.id, 'create_document', {
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
    const created = (await exec(writeTok, seed.user.id, 'create_document', {
      workspace_slug: 'acme',
      project_slug: 'web',
      type: 'work_item',
      title: 'Parent',
    })) as { content: { text: string }[] };
    const parent = JSON.parse(created.content[0]!.text) as { slug: string };

    const out = (await exec(writeTok, seed.user.id, 'create_comment', {
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
      await exec(token, `agent:${agentSlug}`, 'delete_agent', {
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
      await exec(pat, seed.user.id, 'create_agent', {
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
      await exec(pat, seed.user.id, 'update_agent', {
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
      await exec(pat, seed.user.id, 'delete_agent', {
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
      await exec(pat, seed.user.id, 'get_agent_self', {});
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
    const out = (await exec(token, `agent:${agentSlug}`, 'get_agent_self', {})) as {
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
      await exec(token, `agent:${agentSlug}`, 'create_agent', {
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
      await exec(token, `agent:${agentSlug}`, 'create_agent', {
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
    // The agent body IS the prompt (snapshot at run-create); createRun rejects
    // an empty body, so seed a non-empty one.
    body: 'You are a helper.',
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

/** Bootstrap __system + return its id, for seeding a library agent (B1). */
async function seedSystemWorkspaceForRun(db: DB): Promise<{ id: string }> {
  await bootstrapSystemWorkspace(db);
  const sys = await db.query.workspaces.findFirst({
    where: eq(workspaces.slug, SYSTEM_WORKSPACE_SLUG),
  });
  if (!sys) throw new Error('test setup: __system did not bootstrap');
  return { id: sys.id };
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

    const out = await exec(token, seed.user.id, 'run_agent', {
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

  it('run_agent resolves a __system library agent (B1, create path)', async () => {
    const { db, seed } = await makeTestApp();
    const parent = await seedWorkItem(db, seed.workspace, seed.project, seed.user);
    const sys = await seedSystemWorkspaceForRun(db);
    // Library agent lives in __system; the human PAT is scoped to the run-ws (acme).
    await seedRunAgent(db, sys.id, seed.user.id, 'operator');
    const { token } = await seedRunAgent(db, seed.workspace.id, seed.user.id, 'caller');

    const out = await exec(token, seed.user.id, 'run_agent', {
      workspace_slug: 'acme',
      agent_slug: 'operator',
      parent_slug: parent.slug,
    });
    const res = parseText<{ run_id: string; status: string }>(out);
    expect(res.status).toBe('planning');
    const row = await db.query.documents.findFirst({ where: eq(documents.id, res.run_id) });
    expect(row?.type).toBe('agent_run');
    // Home is stamped from the agent's workspace → __system, not the run-ws.
    expect((row?.frontmatter as Record<string, unknown>).agent_home_workspace_id).toBe(sys.id);
  });

  it('run_agent with input posts a comment to the parent (mit 59)', async () => {
    const { db, seed } = await makeTestApp();
    const parent = await seedWorkItem(db, seed.workspace, seed.project, seed.user);
    await seedRunAgent(db, seed.workspace.id, seed.user.id, 'helper');
    const { token } = await seedRunAgent(db, seed.workspace.id, seed.user.id, 'helper2');

    await exec(token, seed.user.id, 'run_agent', {
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
      await exec(token, seed.user.id, 'list_runs', {
        workspace_slug: 'acme',
        project_slug: 'web',
      }),
    );
    expect(listed.map((r) => r.id)).toContain(run.id);

    const got = parseText<{ id: string; type: string }>(
      await exec(token, seed.user.id, 'get_run', {
        workspace_slug: 'acme',
        run_id: run.id,
      }),
    );
    expect(got.id).toBe(run.id);
    expect(got.type).toBe('agent_run');
  });

  it('get_run does NOT leak frontmatter.system_prompt (redacted at the loader)', async () => {
    const { db, seed } = await makeTestApp();
    const parent = await seedWorkItem(db, seed.workspace, seed.project, seed.user);
    const { agent, token } = await seedRunAgent(db, seed.workspace.id, seed.user.id, 'helper');
    const run = await seedRunRow(db, seed.workspace, seed.project, agent, seed.user, parent);

    // Stamp a distinctive secret onto the run's snapshotted system_prompt.
    await db
      .update(documents)
      .set({
        frontmatter: { ...(run.frontmatter as Record<string, unknown>), system_prompt: 'SECRET' },
      })
      .where(eq(documents.id, run.id));

    const out = await exec(token, seed.user.id, 'get_run', {
      workspace_slug: 'acme',
      run_id: run.id,
    });
    const raw = (out as { content: { text: string }[] }).content[0]!.text;
    expect(raw).not.toContain('SECRET');
    expect(raw).not.toContain('system_prompt');
    const got = parseText<{ frontmatter: Record<string, unknown> }>(out);
    expect(got.frontmatter.system_prompt).toBeUndefined();
  });

  it('list_runs does NOT leak frontmatter.system_prompt (redacted per row)', async () => {
    const { db, seed } = await makeTestApp();
    const parent = await seedWorkItem(db, seed.workspace, seed.project, seed.user);
    const { agent, token } = await seedRunAgent(db, seed.workspace.id, seed.user.id, 'helper');
    const run = await seedRunRow(db, seed.workspace, seed.project, agent, seed.user, parent);
    await db
      .update(documents)
      .set({
        frontmatter: { ...(run.frontmatter as Record<string, unknown>), system_prompt: 'SECRET' },
      })
      .where(eq(documents.id, run.id));

    const out = await exec(token, seed.user.id, 'list_runs', {
      workspace_slug: 'acme',
      project_slug: 'web',
    });
    const raw = (out as { content: { text: string }[] }).content[0]!.text;
    expect(raw).not.toContain('SECRET');
    expect(raw).not.toContain('system_prompt');
  });

  it('cancel_run on a planning run → failed (parity with HTTP cancel)', async () => {
    const { db, seed } = await makeTestApp();
    const parent = await seedWorkItem(db, seed.workspace, seed.project, seed.user);
    const { agent, token } = await seedRunAgent(db, seed.workspace.id, seed.user.id, 'helper');
    const run = await seedRunRow(db, seed.workspace, seed.project, agent, seed.user, parent);

    const res = parseText<{ run_id: string; status: string }>(
      await exec(token, seed.user.id, 'cancel_run', {
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
      await exec(token, seed.user.id, 'retry_run', {
        workspace_slug: 'acme',
        run_id: run.id,
      }),
    );
    expect(res.status).toBe('planning');
    expect(res.run_id).not.toBe(run.id);
    const rows = await db.query.documents.findMany({ where: eq(documents.type, 'agent_run') });
    expect(rows.length).toBe(2);
  });

  it('retry_run of a __system library-agent run re-resolves the library agent (not 404) (B1, retry path)', async () => {
    const { db, seed } = await makeTestApp();
    const parent = await seedWorkItem(db, seed.workspace, seed.project, seed.user);
    const sys = await seedSystemWorkspaceForRun(db);
    // Library agent lives in __system; the human PAT is scoped to the run-ws (acme).
    const { agent } = await seedRunAgent(db, sys.id, seed.user.id, 'operator');
    const { token } = await seedRunAgent(db, seed.workspace.id, seed.user.id, 'caller');
    // createRun (B's create path) stamps agent_home_workspace_id = __system.
    const run = await seedRunRow(db, seed.workspace, seed.project, agent, seed.user, parent);
    expect((run.frontmatter as Record<string, unknown>).agent_home_workspace_id).toBe(sys.id);
    await db
      .update(documents)
      .set({
        status: 'failed',
        frontmatter: { ...(run.frontmatter as Record<string, unknown>), status: 'failed' },
      })
      .where(eq(documents.id, run.id));

    // RED before the fix: agent_not_found (re-resolve was eq(workspaceId, ws.id) only).
    const res = parseText<{ run_id: string; status: string }>(
      await exec(token, seed.user.id, 'retry_run', {
        workspace_slug: 'acme',
        run_id: run.id,
      }),
    );
    expect(res.status).toBe('planning');
    const fresh = await db.query.documents.findFirst({ where: eq(documents.id, res.run_id) });
    expect((fresh!.frontmatter as Record<string, unknown>).agent_home_workspace_id).toBe(sys.id);
  });

  it('retry_run while original still active → RUN_ALREADY_ACTIVE (mit 63)', async () => {
    const { db, seed } = await makeTestApp();
    const parent = await seedWorkItem(db, seed.workspace, seed.project, seed.user);
    const { agent, token } = await seedRunAgent(db, seed.workspace.id, seed.user.id, 'helper');
    const run = await seedRunRow(db, seed.workspace, seed.project, agent, seed.user, parent);

    let thrown: unknown;
    try {
      await exec(token, seed.user.id, 'retry_run', {
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

    await exec(token, seed.user.id, 'run_agent', argsBag);
    let thrown: unknown;
    try {
      await exec(token, seed.user.id, 'run_agent', argsBag);
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
      await exec(token, `agent:${agent.slug}`, 'run_agent', {
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
      await exec(token, `agent:${agent.slug}`, 'retry_run', {
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
        await exec(token, `agent:${agent.slug}`, 'retry_run', {
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
    await exec(token, seed.user.id, 'run_agent', argsBag);
    const before = (await listComments({ parentId: parent.id })).length;
    expect(before).toBe(1);

    // Duplicate (active) create with input → must reject BEFORE the comment.
    let thrown: unknown;
    try {
      await exec(token, seed.user.id, 'run_agent', { ...argsBag, input: 'second input' });
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
        await exec(token, seed.user.id, tool, {
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
      await exec(token, seed.user.id, 'run_agent', {
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

describe('tool descriptions teach the new ergonomics', () => {
  it('tool descriptions teach the new ergonomics', () => {
    const defs = listToolDefs();
    const byName = Object.fromEntries(defs.map((d) => [d.name, d.description]));
    expect(byName['list_documents']).toContain('list_comments');
    expect(byName['update_document']).toContain('list_statuses');
    expect(byName['find_documents']).toContain('do NOT page through');
  });
});

describe('find_documents: workspace-wide title lookup, allow-list enforced', () => {
  it('find_documents resolves a title workspace-wide with project_slug in results', async () => {
    const { db, seed } = await makeTestApp();
    const token = await seedHumanPat(db, seed.workspace.id, seed.user.id, [
      'documents:read',
      'documents:write',
    ]);
    // Create a work_item titled "Combell setup" in seed.project (slug 'web').
    await exec(token, seed.user.id, 'create_document', {
      workspace_slug: 'acme',
      project_slug: 'web',
      type: 'work_item',
      title: 'Combell setup',
    });

    const res = (await exec(token, seed.user.id, 'find_documents', {
      workspace_slug: 'acme',
      query: 'combell',
    })) as { content: { text: string }[] };
    const out = JSON.parse(res.content[0]!.text) as {
      documents: { title: string; project_slug: string | null }[];
    };
    expect(out.documents).toHaveLength(1);
    expect(out.documents[0]).toMatchObject({ title: 'Combell setup', project_slug: 'web' });
  });

  it('find_documents rejects limit:0 (would otherwise silently return empty)', async () => {
    const { db, seed } = await makeTestApp();
    const token = await seedHumanPat(db, seed.workspace.id, seed.user.id, [
      'documents:read',
      'documents:write',
    ]);
    await exec(token, seed.user.id, 'create_document', {
      workspace_slug: 'acme',
      project_slug: 'web',
      type: 'work_item',
      title: 'Combell setup',
    });
    // limit:0 must be rejected by the schema (min(1)), not honored as LIMIT 0.
    await expect(
      exec(token, seed.user.id, 'find_documents', {
        workspace_slug: 'acme',
        query: 'combell',
        limit: 0,
      }),
    ).rejects.toThrow();
  });

  it('find_documents does NOT return docs from a non-allow-listed project (agent token)', async () => {
    const { db, seed } = await makeTestApp();

    // Second project ('ops') in the SAME workspace.
    const projectBId = nanoid();
    await db.insert(projects).values({
      id: projectBId,
      workspaceId: seed.workspace.id,
      slug: 'ops',
      name: 'Ops',
    });
    await seedProjectDefaults(db, projectBId);

    // A human PAT seeds a matching doc in BOTH 'web' and 'ops'.
    const pat = await seedHumanPat(db, seed.workspace.id, seed.user.id, ['documents:write']);
    await exec(pat, seed.user.id, 'create_document', {
      workspace_slug: 'acme',
      project_slug: 'web',
      type: 'work_item',
      title: 'Combell web',
    });
    await exec(pat, seed.user.id, 'create_document', {
      workspace_slug: 'acme',
      project_slug: 'ops',
      type: 'work_item',
      title: 'Combell ops',
    });

    // Agent token allow-listed to ONLY the 'web' project (frontmatter.projects).
    const { token: agentToken, agentSlug } = await seedAgent(
      db,
      seed.workspace.id,
      seed.user.id,
      { projects: [seed.project.id], scopes: ['documents:read'] },
    );

    const res = (await exec(agentToken, `agent:${agentSlug}`, 'find_documents', {
      workspace_slug: 'acme',
      query: 'combell',
    })) as { content: { text: string }[] };
    const out = JSON.parse(res.content[0]!.text) as {
      documents: { project_slug: string | null }[];
    };
    const slugs = out.documents.map((d) => d.project_slug);
    expect(slugs).not.toContain('ops'); // non-allow-listed project's match must be absent
    expect(slugs).toContain('web');
  });
});

describe('caller project intersect (D4/D5): central clamp folded into token.projectIds', () => {
  it('caller not in the project → tool rejected even when agent allow-lists it', async () => {
    const { db, seed } = await makeTestApp();

    // Second project ('ops') in the SAME workspace.
    const projectBId = nanoid();
    await db.insert(projects).values({
      id: projectBId,
      workspaceId: seed.workspace.id,
      slug: 'ops',
      name: 'Ops',
    });
    await seedProjectDefaults(db, projectBId);

    // Seed a doc in 'ops' so the only thing that can reject is the project clamp.
    const pat = await seedHumanPat(db, seed.workspace.id, seed.user.id, [
      'documents:read',
      'documents:write',
    ]);
    await exec(pat, seed.user.id, 'create_document', {
      workspace_slug: 'acme',
      project_slug: 'ops',
      type: 'work_item',
      title: 'Ops doc',
    });
    const opsDoc = (
      JSON.parse(
        (
          (await exec(pat, seed.user.id, 'find_documents', {
            workspace_slug: 'acme',
            project_slug: 'ops',
            query: 'ops doc',
          })) as { content: { text: string }[] }
        ).content[0]!.text,
      ) as { documents: { slug: string }[] }
    ).documents[0]!;

    // Agent token allow-lists BOTH projects (wildcard); token unrestricted.
    const { token: agentToken, agentSlug } = await seedAgent(db, seed.workspace.id, seed.user.id, {
      projects: ['*'],
      scopes: ['documents:read'],
    });

    // Caller is a regular member clamped to the 'web' project only — NOT 'ops'.
    // The runner's loadContext folds that clamp into token.projectIds before any
    // tool runs; replicate it here, then drive the tool with the narrowed token.
    const narrowed = narrowTokenToCaller(agentToken, [seed.project.id]);
    let thrown: unknown;
    try {
      await executeTool(
        narrowed,
        `agent:${agentSlug}`,
        'get_document',
        { workspace_slug: 'acme', project_slug: 'ops', slug: opsDoc.slug },
        undefined,
        { callerScopes: ['documents:read'] },
      );
    } catch (err) {
      thrown = err;
    }
    const e = thrown as Error & { code?: number; data?: { reason?: string } };
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe(-32602);
    expect(e.data?.reason).toBe('agent_not_in_allow_list');
  });

  it('caller is owner (callerProjectIds null) → no extra narrowing; agent allow-list still applies', async () => {
    const { db, seed } = await makeTestApp();

    // Second project ('ops') in the SAME workspace.
    const projectBId = nanoid();
    await db.insert(projects).values({
      id: projectBId,
      workspaceId: seed.workspace.id,
      slug: 'ops',
      name: 'Ops',
    });
    await seedProjectDefaults(db, projectBId);

    const pat = await seedHumanPat(db, seed.workspace.id, seed.user.id, [
      'documents:read',
      'documents:write',
    ]);
    await exec(pat, seed.user.id, 'create_document', {
      workspace_slug: 'acme',
      project_slug: 'ops',
      type: 'work_item',
      title: 'Ops doc',
    });
    const opsDoc = (
      JSON.parse(
        (
          (await exec(pat, seed.user.id, 'find_documents', {
            workspace_slug: 'acme',
            project_slug: 'ops',
            query: 'ops doc',
          })) as { content: { text: string }[] }
        ).content[0]!.text,
      ) as { documents: { slug: string }[] }
    ).documents[0]!;

    // Agent allow-lists '*'; token unrestricted; OWNER caller (null). The fold
    // intersects the token reach with null → no narrowing, so the owner keeps
    // the agent's full project reach.
    const { token: agentToken, agentSlug } = await seedAgent(db, seed.workspace.id, seed.user.id, {
      projects: ['*'],
      scopes: ['documents:read'],
    });
    const narrowed = narrowTokenToCaller(agentToken, null);

    const out = (await executeTool(
      narrowed,
      `agent:${agentSlug}`,
      'get_document',
      { workspace_slug: 'acme', project_slug: 'ops', slug: opsDoc.slug },
      undefined,
      { callerScopes: ['documents:read'] },
    )) as { content: { text: string }[] };
    const doc = JSON.parse(out.content[0]!.text) as { title: string };
    expect(doc.title).toBe('Ops doc');
  });

  // ----------------------------------------------------------------------
  // The leak the code review found: the THREE enumeration tools that DON'T go
  // through resolveProjectInWorkspace (find_documents no-project_slug branch,
  // describe_workspace, list_projects) filter on token.projectIds. Before the
  // central fold, the caller-project clamp never reached token.projectIds for
  // these paths, so a member delegated to P1 ('web') could enumerate P2's
  // ('ops') docs/projects via an agent allow-listed '*'. With the fold,
  // token.projectIds is caller-narrowed to ['web'] and the leak closes.
  // ----------------------------------------------------------------------
  async function seedTwoProjectLeakFixture(): Promise<{
    db: DB;
    seed: Awaited<ReturnType<typeof makeTestApp>>['seed'];
    narrowed: ApiToken;
    agentSlug: string;
  }> {
    const { db, seed } = await makeTestApp();

    // P2 ('ops') alongside the seeded P1 ('web').
    const opsId = nanoid();
    await db.insert(projects).values({
      id: opsId,
      workspaceId: seed.workspace.id,
      slug: 'ops',
      name: 'Ops',
    });
    await seedProjectDefaults(db, opsId);

    // A matching doc in BOTH projects.
    const pat = await seedHumanPat(db, seed.workspace.id, seed.user.id, ['documents:write']);
    await exec(pat, seed.user.id, 'create_document', {
      workspace_slug: 'acme',
      project_slug: 'web',
      type: 'work_item',
      title: 'Combell web',
    });
    await exec(pat, seed.user.id, 'create_document', {
      workspace_slug: 'acme',
      project_slug: 'ops',
      type: 'work_item',
      title: 'Combell ops',
    });

    // Agent allow-lists '*' (wildcard); the member caller is clamped to P1.
    const { token: agentToken, agentSlug } = await seedAgent(db, seed.workspace.id, seed.user.id, {
      projects: ['*'],
      scopes: ['documents:read'],
    });
    const narrowed = narrowTokenToCaller(agentToken, [seed.project.id]);
    return { db, seed, narrowed, agentSlug };
  }

  it('find_documents (NO project_slug) returns ONLY the caller P1 docs — not P2 (leak fix)', async () => {
    const { seed, narrowed, agentSlug } = await seedTwoProjectLeakFixture();
    const res = (await executeTool(
      narrowed,
      `agent:${agentSlug}`,
      'find_documents',
      { workspace_slug: 'acme', query: 'combell' },
      undefined,
      { callerScopes: ['documents:read'] },
    )) as { content: { text: string }[] };
    const out = JSON.parse(res.content[0]!.text) as {
      documents: { project_slug: string | null }[];
    };
    const slugs = out.documents.map((d) => d.project_slug);
    expect(slugs).toContain('web');
    expect(slugs).not.toContain('ops');
  });

  it('describe_workspace shows ONLY the caller P1 project — not P2 (leak fix)', async () => {
    const { seed, narrowed, agentSlug } = await seedTwoProjectLeakFixture();
    const res = (await executeTool(
      narrowed,
      `agent:${agentSlug}`,
      'describe_workspace',
      { workspace_slug: 'acme' },
      undefined,
      { callerScopes: ['documents:read'] },
    )) as { content: { text: string }[] };
    const out = JSON.parse(res.content[0]!.text) as { projects: { slug: string }[] };
    expect(out.projects.map((p) => p.slug).sort()).toEqual(['web']);
  });

  it('list_projects returns ONLY the caller P1 project — not P2 (leak fix)', async () => {
    const { seed, narrowed, agentSlug } = await seedTwoProjectLeakFixture();
    const res = (await executeTool(
      narrowed,
      `agent:${agentSlug}`,
      'list_projects',
      { workspace_slug: 'acme' },
      undefined,
      { callerScopes: ['documents:read'] },
    )) as { content: { text: string }[] };
    const out = JSON.parse(res.content[0]!.text) as { projects: { slug: string }[] };
    expect(out.projects.map((p) => p.slug).sort()).toEqual(['web']);
  });
});

describe('describe_workspace: one-call orientation, allow-list enforced', () => {
  it('returns projects → tables → status keys', async () => {
    const { db, seed } = await makeTestApp();
    const token = await seedHumanPat(db, seed.workspace.id, seed.user.id, ['documents:read']);
    const res = (await exec(token, seed.user.id, 'describe_workspace', {
      workspace_slug: 'acme',
    })) as { content: { text: string }[] };
    const out = JSON.parse(res.content[0]!.text) as {
      workspace: { slug: string };
      projects: { slug: string; tables: { statuses: { key: string }[] }[] }[];
    };
    expect(out.workspace.slug).toBe('acme');
    const web = out.projects.find((p) => p.slug === 'web');
    expect(web).toBeTruthy();
    expect(web!.tables[0]!.statuses.map((s) => s.key)).toContain('todo');
  });

  it('omits non-allow-listed projects (agent token)', async () => {
    const { db, seed } = await makeTestApp();

    // Second project ('ops') in the SAME workspace — exists, so it would appear
    // absent the allow-list.
    const projectBId = nanoid();
    await db.insert(projects).values({
      id: projectBId,
      workspaceId: seed.workspace.id,
      slug: 'ops',
      name: 'Ops',
    });
    await seedProjectDefaults(db, projectBId);

    // Agent token allow-listed to ONLY the 'web' project (frontmatter.projects).
    const { token: agentToken, agentSlug } = await seedAgent(
      db,
      seed.workspace.id,
      seed.user.id,
      { projects: [seed.project.id], scopes: ['documents:read'] },
    );

    const res = (await exec(agentToken, `agent:${agentSlug}`, 'describe_workspace', {
      workspace_slug: 'acme',
    })) as { content: { text: string }[] };
    const out = JSON.parse(res.content[0]!.text) as { projects: { slug: string }[] };
    expect(out.projects.map((p) => p.slug).sort()).toEqual(['web']); // 'ops' absent
  });
});

describe('A3: instance reach in resolvers', () => {
  it('list_workspaces returns ALL workspaces for an instance token', async () => {
    const { db, seed } = await makeTestApp();
    const bId = nanoid();
    await db.insert(workspaces).values({ id: bId, slug: 'beta', name: 'Beta' });

    const token = makeToken({ workspaceId: null, scopes: ['documents:read'] });
    const res = (await exec(token, seed.user.id, 'list_workspaces', {})) as {
      content: { text: string }[];
    };
    const out = JSON.parse(res.content[0]!.text) as {
      workspaces: { slug: string }[];
    };
    const slugs = out.workspaces.map((w) => w.slug);
    expect(out.workspaces.length).toBeGreaterThanOrEqual(2);
    expect(slugs).toContain('acme');
    expect(slugs).toContain('beta');
  });

  it('list_workspaces returns only its own for a pinned token', async () => {
    const { db, seed } = await makeTestApp();
    const bId = nanoid();
    await db.insert(workspaces).values({ id: bId, slug: 'beta', name: 'Beta' });

    const token = makeToken({ workspaceId: seed.workspace.id, scopes: ['documents:read'] });
    const res = (await exec(token, seed.user.id, 'list_workspaces', {})) as {
      content: { text: string }[];
    };
    const out = JSON.parse(res.content[0]!.text) as {
      workspaces: { slug: string }[];
    };
    expect(out.workspaces).toHaveLength(1);
    expect(out.workspaces[0]!.slug).toBe('acme');
  });

  // CR#4 — an instance token enumerates every workspace EXCEPT the reserved
  // __system library (other surfaces hide it via isReservedSlug; list_workspaces
  // must not leak the reserved namespace).
  it('CR#4: list_workspaces for an instance token excludes the reserved __system workspace', async () => {
    const { db, seed } = await makeTestApp();
    // Bootstrap so a reserved __system workspace exists, plus a normal B.
    await bootstrapSystemWorkspace(db);
    const bId = nanoid();
    await db.insert(workspaces).values({ id: bId, slug: 'beta', name: 'Beta' });

    const token = makeToken({ workspaceId: null, scopes: ['documents:read'] });
    const res = (await exec(token, seed.user.id, 'list_workspaces', {})) as {
      content: { text: string }[];
    };
    const out = JSON.parse(res.content[0]!.text) as {
      workspaces: { slug: string }[];
    };
    const slugs = out.workspaces.map((w) => w.slug);
    // Normal workspaces are listed...
    expect(slugs).toContain('acme');
    expect(slugs).toContain('beta');
    // ...but the reserved __system library is filtered out.
    expect(slugs).not.toContain(SYSTEM_WORKSPACE_SLUG);
    expect(out.workspaces.some((w) => isReservedSlug(w.slug))).toBe(false);
  });

  it('instance token resolves a non-home workspace via a resolver tool', async () => {
    const { db, seed } = await makeTestApp();
    const bId = nanoid();
    await db.insert(workspaces).values({ id: bId, slug: 'beta', name: 'Beta' });
    await db
      .insert(projects)
      .values({ id: nanoid(), workspaceId: bId, slug: 'site', name: 'Site' });

    // Instance token reaches workspace B's projects without throwing.
    const instanceTok = makeToken({ workspaceId: null, scopes: ['documents:read'] });
    const res = (await exec(instanceTok, seed.user.id, 'list_projects', {
      workspace_slug: 'beta',
    })) as { content: { text: string }[] };
    const out = JSON.parse(res.content[0]!.text) as { projects: unknown[] };
    expect(Array.isArray(out.projects)).toBe(true);

    // CONTROL: a pinned-to-acme token must NOT reach workspace B.
    const pinnedTok = makeToken({
      workspaceId: seed.workspace.id,
      scopes: ['documents:read'],
    });
    await expect(
      exec(pinnedTok, seed.user.id, 'list_projects', { workspace_slug: 'beta' }),
    ).rejects.toThrow('workspace not accessible');
  });
});

describe('B2: get_skill narrow __system read (T7)', () => {
  /**
   * Insert a `page` into the __system Skills project with explicit frontmatter.
   * Bootstraps __system first so the Skills project exists.
   */
  async function seedSystemSkillPage(
    db: DB,
    slug: string,
    body: string,
    frontmatter: Record<string, unknown>,
  ): Promise<string> {
    await bootstrapSystemWorkspace(db);
    const systemId = await getSystemWorkspaceId(db);
    const skillsProject = (await db.query.projects.findFirst({
      where: and(eq(projects.workspaceId, systemId), eq(projects.slug, 'skills')),
    }))!;
    await db.insert(documents).values({
      id: nanoid(),
      workspaceId: systemId,
      projectId: skillsProject.id,
      type: 'page',
      title: slug,
      slug,
      body,
      status: null,
      frontmatter,
      createdBy: null,
    });
    return systemId;
  }

  it('returns a __system skill body for a WORKER token pinned to B', async () => {
    const { db, seed } = await makeTestApp();
    await seedSystemSkillPage(db, 'seo', 'SEO-BODY', { trusted: true });
    // Token pinned to workspace B (the regular seed workspace), NOT __system.
    const token = makeToken({ workspaceId: seed.workspace.id, scopes: ['documents:read'] });
    const res = (await exec(token, 'tester', 'get_skill', { slug: 'seo' })) as {
      content: { text: string }[];
    };
    const payload = JSON.parse(res.content[0]!.text) as { body: string; trusted: boolean };
    expect(payload.body).toContain('SEO-BODY');
    expect(payload.trusted).toBe(true);
  });

  it('CANNOT read a non-skill __system doc (e.g. an agent) (T7)', async () => {
    const { db, seed } = await makeTestApp();
    await bootstrapSystemWorkspace(db);
    const systemId = await getSystemWorkspaceId(db);
    // Seed a __system AGENT doc (type=agent, NOT a type=page under skills).
    await db.insert(documents).values({
      id: nanoid(),
      workspaceId: systemId,
      projectId: null,
      type: 'agent',
      title: 'operator',
      slug: 'operator',
      body: 'help',
      status: null,
      frontmatter: { system_prompt: 'x' },
      createdBy: null,
    });
    const token = makeToken({ workspaceId: seed.workspace.id, scopes: ['documents:read'] });
    await expect(exec(token, 'tester', 'get_skill', { slug: 'operator' })).rejects.toThrow(
      'skill not found',
    );
  });

  it("cannot read another workspace's doc (T7)", async () => {
    const { db, seed } = await makeTestApp();
    await bootstrapSystemWorkspace(db);
    // A page in workspace B (NOT __system/skills) with slug 'bdoc'.
    await db.insert(documents).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      projectId: seed.project.id,
      type: 'page',
      title: 'bdoc',
      slug: 'bdoc',
      body: 'B-WORKSPACE-BODY',
      status: null,
      frontmatter: {},
      createdBy: null,
    });
    const token = makeToken({ workspaceId: seed.workspace.id, scopes: ['documents:read'] });
    await expect(exec(token, 'tester', 'get_skill', { slug: 'bdoc' })).rejects.toThrow(
      'skill not found',
    );
  });

  it('requires documents:read', async () => {
    const { db } = await makeTestApp();
    await seedSystemSkillPage(db, 'seo', 'SEO-BODY', { trusted: true });
    await expect(
      executeTool(makeToken({ scopes: [] }), 'tester', 'get_skill', { slug: 'seo' }, undefined, {
        callerScopes: [],
      }),
    ).rejects.toThrow(/scope/);
  });
});

describe('B3: set_skill_trust (T8 separation of duties)', () => {
  /** Insert a __system Skills page; returns the systemId + skills project + doc id. */
  async function seedSkill(
    db: DB,
    slug: string,
    frontmatter: Record<string, unknown>,
  ): Promise<{ systemId: string; skillsProjectId: string; docId: string }> {
    await bootstrapSystemWorkspace(db);
    const systemId = await getSystemWorkspaceId(db);
    const skillsProject = (await db.query.projects.findFirst({
      where: and(eq(projects.workspaceId, systemId), eq(projects.slug, 'skills')),
    }))!;
    const docId = nanoid();
    await db.insert(documents).values({
      id: docId,
      workspaceId: systemId,
      projectId: skillsProject.id,
      type: 'page',
      title: slug,
      slug,
      body: 'BODY',
      status: null,
      frontmatter,
      createdBy: null,
    });
    return { systemId, skillsProjectId: skillsProject.id, docId };
  }

  it('an MCP PAT (createdBy = a human) is REFUSED and trusted stays false', async () => {
    const { db } = await makeTestApp();
    const { docId } = await seedSkill(db, 'evil', { trusted: false });
    // An MCP admin PAT: a human createdBy + config:write scope. By T8 it may NOT bless.
    const token = makeToken({ createdBy: 'u-human', scopes: ['config:write', 'documents:read'] });
    const res = (await exec(token, 'u-human', 'set_skill_trust', {
      slug: 'evil',
      trusted: true,
    })) as { content: { text: string }[] };
    const payload = JSON.parse(res.content[0]!.text) as { refused?: boolean };
    expect(payload.refused).toBe(true);
    const doc = await db.query.documents.findFirst({ where: eq(documents.id, docId) });
    expect((doc!.frontmatter as Record<string, unknown>).trusted).toBe(false);
  });

  it('the operator token (createdBy null) flips trusted + emits skill.trust.changed', async () => {
    const { db } = await makeTestApp();
    const { docId } = await seedSkill(db, 'evil', { trusted: false });
    // Operator token: createdBy null (system origin) + config:write.
    const token = makeToken({ createdBy: null, scopes: ['config:write', 'documents:read'] });
    const res = (await exec(token, 'operator', 'set_skill_trust', {
      slug: 'evil',
      trusted: true,
    })) as { content: { text: string }[] };
    const payload = JSON.parse(res.content[0]!.text) as { ok?: boolean; refused?: boolean };
    expect(payload.ok).toBe(true);
    expect(payload.refused).toBeUndefined();
    const doc = await db.query.documents.findFirst({ where: eq(documents.id, docId) });
    expect((doc!.frontmatter as Record<string, unknown>).trusted).toBe(true);
    const evts = await db.query.events.findMany({
      where: eq(events.kind, 'skill.trust.changed'),
    });
    expect(evts.length).toBeGreaterThanOrEqual(1);
    expect(evts.some((e) => (e.payload as { slug?: string }).slug === 'evil')).toBe(true);
  });

  it('a normal update_document to a __system skill page CANNOT set trusted (strip)', async () => {
    const { db, seed } = await makeTestApp();
    const { systemId, skillsProjectId, docId } = await seedSkill(db, 'evil', { trusted: false });
    const ws = (await db.query.workspaces.findFirst({ where: eq(workspaces.id, systemId) }))!;
    const project = (await db.query.projects.findFirst({
      where: eq(projects.id, skillsProjectId),
    }))!;
    const existing = (await db.query.documents.findFirst({ where: eq(documents.id, docId) }))!;
    const user = seed.user; // a real user row (FK on documents.updated_by)
    // A write that TRIES to flip trusted via the generic document path. The key
    // must be stripped — trusted stays false (only setSkillTrust may change it).
    const { updateDocument } = await import('../services/documents.ts');
    await updateDocument({
      workspace: ws,
      project,
      existing,
      actor: user,
      fallbackTable: null,
      patch: { frontmatter: { trusted: true, note: 'kept' } },
    });
    const after = (await db.query.documents.findFirst({ where: eq(documents.id, docId) }))!;
    const fm = after.frontmatter as Record<string, unknown>;
    expect(fm.trusted).toBe(false); // stripped — unchanged
    expect(fm.note).toBe('kept'); // a non-managed key still persists
  });
});
