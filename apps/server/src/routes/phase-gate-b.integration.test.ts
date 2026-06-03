/**
 * Phase Gate B — cross-task integration scenarios for the "skills" feature
 * (Piece B, B1–B5). These exercise the REAL DB, the REAL runner `loadContext`
 * (which calls module-private `loadAgentDefinition`), the REAL `get_skill` /
 * `set_skill_trust` TOOL handlers via `executeTool`, and the REAL `setSkillTrust`
 * trust gate + `updateDocument` strip — asserting BOTH behaviour AND persisted
 * state. They catch paths that compose across tasks B1–B5 that the per-task
 * unit tests in `runner.test.ts` / `skill-trust.test.ts` exercise in isolation.
 *
 * Scenario coverage:
 *  - S1 (B1 + B2) — a worker agent in workspace B pulls + pushes a __system
 *    skill: loadContext resolves the skill from __system (not B), and get_skill
 *    returns the same body via a B-pinned documents:read token. Negatives prove
 *    the type=page T7 fence (a __system AGENT slug, a B-only doc → not-found).
 *  - S2 (B3 + B1) — trust separation of duties end-to-end: a normal create/update
 *    cannot self-bless; an MCP admin PAT (createdBy = human) is REFUSED at
 *    set_skill_trust; the operator token (createdBy null) blesses; the bless
 *    emits a skill.trust.changed event; and a run loading the skill BEFORE the
 *    bless sees it as untrusted.
 *  - Acceptance — HAPPY (operator run with the seeded trusted `folio` skill →
 *    trusted), ERROR (a missing skill slug → clean MISSING_SKILL, not a 500
 *    internals leak), EDGE (get_skill works for documents:read but set_skill_trust
 *    from an MCP PAT is refused — folded into S1/S2).
 */

import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { aiKeys, apiTokens, documents, events, projects, tables } from '../db/schema.ts';
import type { ApiToken, Document, User } from '../db/schema.ts';
import { newApiToken } from '../lib/auth.ts';
import { encryptSecret } from '../lib/crypto.ts';
import { executeTool } from '../lib/agent-tools.ts';
import { registerRealTools } from '../lib/agent-tools-registry.ts';
import { loadContext } from '../lib/runner.ts';
import { updateDocument } from '../services/documents.ts';
import {
  bootstrapSystemWorkspace,
  getSystemWorkspaceId,
} from '../lib/system-workspace.ts';
import { makeTestApp } from '../test/harness.ts';

// folio_api / get_skill / set_skill_trust are registered via registerRealTools().
// Idempotent-guarded, so calling at module load is safe.
registerRealTools();

type TestDB = Awaited<ReturnType<typeof makeTestApp>>['db'];

// ---------------------------------------------------------------------------
// Shared seeders — replicate the SHAPES of runner.test.ts's
// seedSystemSkillPage / seedWorkerAgentWithSkills / scaffold so this file is
// self-contained while matching the canonical harness exactly.
// ---------------------------------------------------------------------------

/** Parse a tool's `{ content: [{ text }] }` envelope into its JSON payload. */
function toolPayload<T>(out: unknown): T {
  return JSON.parse((out as { content: { text: string }[] }).content[0]!.text) as T;
}

/**
 * Insert a `page` into the __system Skills project with an explicit `trusted`
 * frontmatter flag (B1 trust-channel routing). Bootstraps __system first so the
 * Skills project exists. Mirrors runner.test.ts::seedSystemSkillPage.
 */
async function seedSystemSkillPage(
  db: TestDB,
  slug: string,
  body: string,
  trusted: boolean,
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
    frontmatter: { trusted },
    createdBy: null,
  });
  return systemId;
}

/** Resolve the __system Skills project row (assumes __system bootstrapped). */
async function getSkillsProject(db: TestDB, systemId: string) {
  return (await db.query.projects.findFirst({
    where: and(eq(projects.workspaceId, systemId), eq(projects.slug, 'skills')),
  }))!;
}

/**
 * Seed an agent document + its bound api token. Mirrors
 * runner.test.ts::seedAgent (the relevant subset). `home` is the workspace the
 * agent doc lives in; `frontmatter.skills` declares which __system skills load.
 */
async function seedAgent(
  db: TestDB,
  homeWorkspaceId: string,
  userId: string,
  slug: string,
  skills: string[],
  tokenWorkspaceId: string | null,
  tokenScopes: string[],
  tokenOverrides: Partial<ApiToken> = {},
): Promise<{ agent: Document; token: ApiToken }> {
  const id = nanoid();
  const { hash } = newApiToken();
  const apiTokenId = nanoid();
  await db.insert(documents).values({
    id,
    workspaceId: homeWorkspaceId,
    projectId: null,
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
      projects: ['*'],
      skills,
      api_token_id: apiTokenId,
    },
    createdBy: userId,
    updatedBy: userId,
  });
  await db.insert(apiTokens).values({
    id: apiTokenId,
    workspaceId: tokenWorkspaceId,
    name: `agent:${slug}`,
    tokenHash: hash,
    scopes: tokenScopes,
    agentId: id,
    createdBy: userId,
    ...tokenOverrides,
  });
  const agent = (await db.query.documents.findFirst({ where: eq(documents.id, id) }))!;
  const token = (await db.query.apiTokens.findFirst({
    where: eq(apiTokens.id, apiTokenId),
  }))!;
  return { agent, token };
}

/**
 * A minimal running run + parent work item in workspace B, stamped so
 * loadContext resolves `agentSlug` whose home is `homeWorkspaceId`. Returns the
 * run document. The parent + run live in B's seeded default project/table.
 */
async function seedRunForAgent(
  db: TestDB,
  args: {
    workspaceId: string;
    projectId: string;
    userId: string;
    agentSlug: string;
    agentHomeWorkspaceId: string;
  },
): Promise<Document> {
  // Reuse B's seeded "Work Items" table for the parent, and create a runs table.
  const wiTable = (await db.query.tables.findFirst({
    where: (t, { eq: e, and: a }) => a(e(t.projectId, args.projectId), e(t.slug, 'work-items')),
  }))!;
  const runsTableId = nanoid();
  await db.insert(tables).values({
    id: runsTableId,
    projectId: args.projectId,
    slug: 'agent-runs',
    name: 'Agent Runs',
    order: 99,
  });

  const parentId = nanoid();
  await db.insert(documents).values({
    id: parentId,
    workspaceId: args.workspaceId,
    projectId: args.projectId,
    tableId: wiTable.id,
    type: 'work_item',
    slug: `parent-${nanoid(6)}`,
    title: 'Parent task',
    status: 'todo',
    body: 'Do the task.',
    frontmatter: {},
    createdBy: args.userId,
    updatedBy: args.userId,
  });

  const runId = nanoid();
  const now = new Date().toISOString();
  await db.insert(documents).values({
    id: runId,
    workspaceId: args.workspaceId,
    projectId: args.projectId,
    tableId: runsTableId,
    type: 'agent_run',
    slug: `${args.agentSlug}-run-${nanoid(8)}`,
    title: `${args.agentSlug} run`,
    status: 'running',
    body: '',
    frontmatter: {
      assignee: `agent:${args.agentSlug}`,
      status: 'running',
      agent_slug: args.agentSlug,
      agent_home_workspace_id: args.agentHomeWorkspaceId,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      system_prompt: 'You are a helper.',
      max_tokens: 12_345,
      tokens_in: 0,
      tokens_out: 0,
      trigger_id: null,
      chain_id: crypto.randomUUID(),
      fired_by: 'agent.task.assigned',
      started_at: now,
      worker_started_at: now,
      // The harness user is the workspace OWNER → full owner caller scopes.
      caller_scopes: ['documents:read', 'documents:write', 'documents:delete', 'agents:write'],
      caller_project_ids: null,
    },
    parentId,
    createdBy: args.userId,
    updatedBy: args.userId,
  });
  return (await db.query.documents.findFirst({ where: eq(documents.id, runId) }))!;
}

/** Seed an ai key for a workspace so the runner pre-flight doesn't block. */
async function seedAiKey(db: TestDB, workspaceId: string): Promise<void> {
  await db.insert(aiKeys).values({
    id: nanoid(),
    workspaceId,
    provider: 'anthropic',
    label: 'default',
    encryptedKey: encryptSecret('sk-test-fake-key'),
  });
}

// ===========================================================================
// S1 — a worker in B pulls + pushes a __system skill (B1 + B2)
// ===========================================================================
//
// SCENARIO: __system bootstrapped with a `seo` skills page (trusted:true, body
//   'SEO-GUIDANCE'). A WORKER agent whose home is the regular workspace B
//   declares frontmatter.skills:['seo'] and has a token PINNED to B.
//   WHEN:  (push) loadContext(run) resolves the agent's loaded skills.
//          (pull) get_skill({slug:'seo'}) is called with the B-pinned token.
//   THEN:  push — ctx.agentSkills has 'seo' trusted:true with the body, resolved
//          from __system (B has no Skills project) — proving the cross-__system
//          push. pull — get_skill returns the seo body. NEGATIVES — get_skill on
//          a __system AGENT slug → not-found (type=page T7 fence); get_skill on a
//          doc that exists only in B → not-found.
// ===========================================================================

describe('S1: worker in B pulls + pushes a __system skill (B1 + B2)', () => {
  test('loadContext resolves seo from __system; get_skill returns it; negatives fail closed', async () => {
    const { db, seed } = await makeTestApp();
    const bWorkspaceId = seed.workspace.id;
    const bProjectId = seed.project.id;
    await seedAiKey(db, bWorkspaceId);

    // __system skill `seo` (trusted), and a __system AGENT `operator` (a non-page
    // doc the type=page fence must NOT return).
    const systemId = await seedSystemSkillPage(db, 'seo', 'SEO-GUIDANCE', true);
    const skillsProject = await getSkillsProject(db, systemId);
    // Seed a __system agent (type='agent') named 'operator' under __system.
    await db.insert(documents).values({
      id: nanoid(),
      workspaceId: systemId,
      projectId: null,
      type: 'agent',
      slug: 'operator',
      title: 'operator',
      status: null,
      body: 'OPERATOR-AGENT-BODY',
      frontmatter: { system_prompt: 'x', provider: 'anthropic', model: 'm', tools: [] },
      createdBy: null,
    });

    // A doc that exists ONLY in B (a regular work item) — get_skill must not find
    // it (it reaches only __system skills pages).
    const bOnlySlug = `b-only-${nanoid(6)}`;
    const wiTable = (await db.query.tables.findFirst({
      where: (t, { eq: e, and: a }) => a(e(t.projectId, bProjectId), e(t.slug, 'work-items')),
    }))!;
    await db.insert(documents).values({
      id: nanoid(),
      workspaceId: bWorkspaceId,
      projectId: bProjectId,
      tableId: wiTable.id,
      type: 'work_item',
      slug: bOnlySlug,
      title: 'B only',
      status: 'todo',
      body: 'B-LOCAL-BODY',
      frontmatter: {},
      createdBy: seed.user.id,
    });

    // Worker agent: home = B; token pinned to B with documents:read.
    const { token: workerToken } = await seedAgent(
      db,
      bWorkspaceId,
      seed.user.id,
      'worker',
      ['seo'],
      bWorkspaceId, // token pinned to B
      ['documents:read'],
    );

    // The run, stamped so loadContext resolves `worker` (home = B).
    const run = await seedRunForAgent(db, {
      workspaceId: bWorkspaceId,
      projectId: bProjectId,
      userId: seed.user.id,
      agentSlug: 'worker',
      agentHomeWorkspaceId: bWorkspaceId,
    });

    // --- PUSH: loadContext resolves the skill from __system, not from B. ---
    const ctx = await loadContext(run.id);
    expect(ctx).not.toBeNull();
    expect(ctx!.agentSkills.length).toBe(1);
    expect(ctx!.agentSkills[0]!.slug).toBe('seo');
    expect(ctx!.agentSkills[0]!.trusted).toBe(true);
    // Body came from the __system page — B has no Skills project at all.
    expect(ctx!.agentSkills[0]!.body).toBe('SEO-GUIDANCE');
    // Prove provenance: the seo page lives under __system's skills project.
    const seoPage = await db.query.documents.findFirst({
      where: and(
        eq(documents.workspaceId, systemId),
        eq(documents.projectId, skillsProject.id),
        eq(documents.slug, 'seo'),
        eq(documents.type, 'page'),
      ),
    });
    expect(seoPage).toBeDefined();
    expect(seoPage!.workspaceId).toBe(systemId);
    expect(seoPage!.workspaceId).not.toBe(bWorkspaceId);

    // --- PULL: get_skill with the B-pinned worker token returns the seo body. ---
    const pulled = toolPayload<{ slug: string; body: string; trusted: boolean }>(
      await executeTool(workerToken, 'agent:worker', 'get_skill', { slug: 'seo' }, undefined, {
        callerScopes: ['documents:read'],
      }),
    );
    expect(pulled.slug).toBe('seo');
    expect(pulled.body).toBe('SEO-GUIDANCE');
    expect(pulled.trusted).toBe(true);

    // --- NEGATIVE 1: a __system AGENT slug is NOT a page → not found (T7). ---
    await expect(
      executeTool(workerToken, 'agent:worker', 'get_skill', { slug: 'operator' }, undefined, {
        callerScopes: ['documents:read'],
      }),
    ).rejects.toThrow('skill not found');

    // --- NEGATIVE 2: a doc that exists ONLY in B is unreachable via get_skill. ---
    await expect(
      executeTool(workerToken, 'agent:worker', 'get_skill', { slug: bOnlySlug }, undefined, {
        callerScopes: ['documents:read'],
      }),
    ).rejects.toThrow('skill not found');
  });
});

// ===========================================================================
// S2 — trust separation of duties end-to-end (B3 + B1)
// ===========================================================================
//
// SCENARIO: an MCP admin PAT (createdBy = a human user) and the operator token
//   (createdBy null) both attempt to bless a __system `evil` skill seeded
//   trusted:false. A normal update_document with frontmatter{trusted:true} must
//   NOT flip it. Only the operator may bless; the bless emits a
//   skill.trust.changed event. A run loading `evil` BEFORE the bless gets it as
//   untrusted (would ride the untrusted DATA envelope, not the trusted channel).
// ===========================================================================

describe('S2: trust separation of duties end-to-end (B3 + B1)', () => {
  test('normal write cannot bless; MCP PAT refused; operator blesses + emits event; pre-bless run untrusted', async () => {
    const { db, seed } = await makeTestApp();
    const bWorkspaceId = seed.workspace.id;
    const bProjectId = seed.project.id;
    await seedAiKey(db, bWorkspaceId);

    // `evil` seeded trusted:false (a normal create — body cannot self-bless).
    const systemId = await seedSystemSkillPage(db, 'evil', 'EVIL-SKILL-BODY', false);
    const skillsProject = await getSkillsProject(db, systemId);
    const systemWs = (await db.query.workspaces.findFirst({
      where: (w, { eq: e }) => e(w.id, systemId),
    }))!;
    const evilDoc = (await db.query.documents.findFirst({
      where: and(
        eq(documents.workspaceId, systemId),
        eq(documents.projectId, skillsProject.id),
        eq(documents.slug, 'evil'),
        eq(documents.type, 'page'),
      ),
    }))!;
    expect((evilDoc.frontmatter as { trusted?: boolean }).trusted).toBe(false);

    // --- A worker run that loads `evil` BEFORE any bless. Worker home = B. ---
    await seedAgent(
      db,
      bWorkspaceId,
      seed.user.id,
      'worker',
      ['evil'],
      bWorkspaceId,
      ['documents:read'],
    );
    const run = await seedRunForAgent(db, {
      workspaceId: bWorkspaceId,
      projectId: bProjectId,
      userId: seed.user.id,
      agentSlug: 'worker',
      agentHomeWorkspaceId: bWorkspaceId,
    });
    const preCtx = await loadContext(run.id);
    expect(preCtx).not.toBeNull();
    expect(preCtx!.agentSkills.length).toBe(1);
    expect(preCtx!.agentSkills[0]!.slug).toBe('evil');
    // SECURITY: an unblessed skill rides the UNTRUSTED channel.
    expect(preCtx!.agentSkills[0]!.trusted).toBe(false);

    // --- A normal update_document with frontmatter{trusted:true} must NOT flip
    //     it (stripManagedSkillTrust on the service layer). ---
    await updateDocument({
      workspace: systemWs,
      project: skillsProject,
      fallbackTable: null,
      actor: { id: seed.user.id } as User,
      existing: evilDoc,
      patch: { frontmatter: { trusted: true, note: 'sneaky' } },
    });
    const afterNormal = (await db.query.documents.findFirst({
      where: eq(documents.id, evilDoc.id),
    }))!;
    // trusted stayed false (stripped); the non-managed key persisted.
    expect((afterNormal.frontmatter as { trusted?: boolean }).trusted).toBe(false);
    expect((afterNormal.frontmatter as { note?: string }).note).toBe('sneaky');

    // --- MCP admin PAT: createdBy = a human user, scopes incl config:write. ---
    const { token: patRaw, hash: patHash } = newApiToken();
    const patId = nanoid();
    await db.insert(apiTokens).values({
      id: patId,
      workspaceId: systemId,
      name: 'mcp-admin-pat',
      tokenHash: patHash,
      scopes: ['documents:read', 'config:write'],
      createdBy: seed.user.id, // a real human → refused by canBlessSkill
    });
    void patRaw;
    const patToken = (await db.query.apiTokens.findFirst({
      where: eq(apiTokens.id, patId),
    }))!;

    // (a) MCP PAT set_skill_trust → REFUSED.
    const patOut = toolPayload<{ refused?: boolean; reason?: string; ok?: boolean }>(
      await executeTool(
        patToken,
        'mcp:admin',
        'set_skill_trust',
        { slug: 'evil', trusted: true },
        undefined,
        { callerScopes: ['config:write'] },
      ),
    );
    expect(patOut.refused).toBe(true);
    expect(patOut.ok).toBeUndefined();
    // DB: still false after the refused PAT attempt.
    const afterPat = (await db.query.documents.findFirst({
      where: eq(documents.id, evilDoc.id),
    }))!;
    expect((afterPat.frontmatter as { trusted?: boolean }).trusted).toBe(false);

    // --- Operator token: createdBy null, scopes incl config:write. ---
    const { hash: opHash } = newApiToken();
    const opId = nanoid();
    await db.insert(apiTokens).values({
      id: opId,
      workspaceId: null,
      name: 'operator',
      tokenHash: opHash,
      scopes: ['documents:read', 'config:write'],
      createdBy: null, // system origin → the live blesser
    });
    const opToken = (await db.query.apiTokens.findFirst({
      where: eq(apiTokens.id, opId),
    }))!;

    // (b) operator set_skill_trust → applied.
    const opOut = toolPayload<{ refused?: boolean; ok?: boolean; trusted?: boolean }>(
      await executeTool(
        opToken,
        'agent:operator',
        'set_skill_trust',
        { slug: 'evil', trusted: true },
        undefined,
        { callerScopes: ['config:write'] },
      ),
    );
    expect(opOut.ok).toBe(true);
    expect(opOut.refused).toBeUndefined();

    // DB: trusted is now true.
    const afterOp = (await db.query.documents.findFirst({
      where: eq(documents.id, evilDoc.id),
    }))!;
    expect((afterOp.frontmatter as { trusted?: boolean }).trusted).toBe(true);

    // A skill.trust.changed event was emitted through the single event path.
    const trustEvents = await db
      .select()
      .from(events)
      .where(eq(events.kind, 'skill.trust.changed'));
    expect(trustEvents.length).toBe(1);
    expect(trustEvents[0]!.documentId).toBe(evilDoc.id);
    expect((trustEvents[0]!.payload as { slug?: string; trusted?: boolean }).slug).toBe('evil');
    expect((trustEvents[0]!.payload as { slug?: string; trusted?: boolean }).trusted).toBe(true);
  });
});

// ===========================================================================
// Acceptance — HAPPY / ERROR (folded into the same file)
// ===========================================================================

describe('Acceptance: skills load happy + error paths', () => {
  test('HAPPY: operator run with the seeded trusted folio skill → trusted channel', async () => {
    const { db, seed } = await makeTestApp();
    const bWorkspaceId = seed.workspace.id;
    const bProjectId = seed.project.id;
    await seedAiKey(db, bWorkspaceId);

    // bootstrapSystemWorkspace seeds the `folio` skill; B4 blesses it
    // (trusted:true). Bootstrap, then assert + ensure the trusted flag is set.
    await bootstrapSystemWorkspace(db);
    const systemId = await getSystemWorkspaceId(db);
    const skillsProject = await getSkillsProject(db, systemId);
    const folio = await db.query.documents.findFirst({
      where: and(
        eq(documents.workspaceId, systemId),
        eq(documents.projectId, skillsProject.id),
        eq(documents.slug, 'folio'),
        eq(documents.type, 'page'),
      ),
    });
    expect(folio).toBeDefined();
    // B4 ships folio trusted:true. Assert the seeded state (the gate's HAPPY
    // contract). If the seed ever regresses, this fails RED.
    expect((folio!.frontmatter as { trusted?: boolean }).trusted).toBe(true);

    // An operator agent whose home IS __system, declaring skills:['folio'].
    await db.insert(documents).values({
      id: nanoid(),
      workspaceId: systemId,
      projectId: null,
      type: 'agent',
      slug: 'operator',
      title: 'operator',
      status: null,
      body: '',
      frontmatter: {
        system_prompt: 'You are the operator.',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
        tools: ['list_documents'],
        projects: ['*'],
        skills: ['folio'],
        api_token_id: 'op-tok-id',
      },
      createdBy: null,
    });
    const { hash } = newApiToken();
    await db.insert(apiTokens).values({
      id: 'op-tok-id',
      workspaceId: null,
      name: 'agent:operator',
      tokenHash: hash,
      scopes: ['documents:read'],
      agentId: (await db.query.documents.findFirst({
        where: and(eq(documents.workspaceId, systemId), eq(documents.slug, 'operator')),
      }))!.id,
      createdBy: null,
    });

    const run = await seedRunForAgent(db, {
      workspaceId: bWorkspaceId,
      projectId: bProjectId,
      userId: seed.user.id,
      agentSlug: 'operator',
      agentHomeWorkspaceId: systemId, // library agent home = __system
    });

    const ctx = await loadContext(run.id);
    expect(ctx).not.toBeNull();
    const folioSkill = ctx!.agentSkills.find((s) => s.slug === 'folio');
    expect(folioSkill).toBeDefined();
    expect(folioSkill!.trusted).toBe(true);
  });

  test('ERROR: a worker declaring a non-existent skill fails MISSING_SKILL (clean, no 500 internals leak)', async () => {
    const { db, seed } = await makeTestApp();
    const bWorkspaceId = seed.workspace.id;
    const bProjectId = seed.project.id;
    await seedAiKey(db, bWorkspaceId);
    await bootstrapSystemWorkspace(db); // Skills project exists; the slug does not.

    await seedAgent(
      db,
      bWorkspaceId,
      seed.user.id,
      'worker',
      ['does-not-exist'],
      bWorkspaceId,
      ['documents:read'],
    );
    const run = await seedRunForAgent(db, {
      workspaceId: bWorkspaceId,
      projectId: bProjectId,
      userId: seed.user.id,
      agentSlug: 'worker',
      agentHomeWorkspaceId: bWorkspaceId,
    });

    // loadContext propagates loadAgentDefinition's HTTPError('MISSING_SKILL').
    // The message names the missing slug — NOT an internals/stack leak.
    let caught: unknown;
    try {
      await loadContext(run.id);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const err = caught as { code?: string; message?: string };
    expect(err.code).toBe('MISSING_SKILL');
    expect(err.message).toContain('does-not-exist');
    // Clean error: it does not leak a raw SQL string or a node stack frame.
    expect(err.message ?? '').not.toMatch(/SELECT |at Object\.|node_modules/);
  });
});
