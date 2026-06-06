/**
 * Operator cockpit chat — Task 5 (createConversationRun + loadContext branch).
 *
 * TIER A (security-critical: the M1/M2 authority floor + the end-to-end wiring
 * assertion that a conversation run is loadable). RED-first, denial path first:
 *   - a MEMBER-owned conversation yields a READ-ONLY operator (no documents:write).
 *   - an OWNER-owned conversation yields the full operator scopes.
 *   - scopes NEVER exceed toolsToScopes(OPERATOR_TOOLS) regardless of role
 *     (operator ∩ caller, never just caller).
 *   - the non-owner project ceiling is bounded to the caller's visible projects;
 *     owner → null (no narrowing).
 *   - SEAM (end-to-end): createConversationRun → loadContext yields a RunContext
 *     with sink + conversationId + the ephemeral operator token + NO parent — the
 *     thing that was impossible before this task.
 */

import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { makeTestApp } from '../test/harness.ts';
import {
  aiKeys,
  conversations,
  instanceSkills,
  projectAccess,
  projects,
  users,
  workspaceAccess,
  workspaces,
} from '../db/schema.ts';
import { encryptSecret } from '../lib/crypto.ts';
import { setOperatorModelSetting } from './instance-settings.ts';
import { roleToScopes, toolsToScopes } from '../lib/agent-schema.ts';
import {
  FOLIO_SKILL_BODY,
  FOLIO_SKILL_SLUG,
  OPERATOR_TOOLS,
} from '../lib/system-skills.ts';
import { loadContext, runAgent } from '../lib/runner.ts';
import {
  __dropPendingConversationRunForTest,
  createConversationRun,
} from './conversation-runs.ts';
import { createConversation } from './conversations.ts';

const OPERATOR_SCOPES = toolsToScopes(OPERATOR_TOOLS);

/**
 * makeTestApp + seed the operator's definitional `folio` skill (T13 seeds this in
 * production). loadContext → loadAgentDefinition hard-fails MISSING_SKILL on a
 * declared-but-absent skill (invariant 11, no silent fallback), so a conversation
 * run requires the operator skill to be present.
 */
async function setup(): Promise<Awaited<ReturnType<typeof makeTestApp>>> {
  const ctx = await makeTestApp();
  await ctx.db.insert(instanceSkills).values({
    id: nanoid(),
    name: FOLIO_SKILL_SLUG,
    body: FOLIO_SKILL_BODY,
    trusted: true,
  });
  return ctx;
}

describe('createConversationRun — M1/M2 authority floor', () => {
  test('a MEMBER-owned conversation yields a READ-ONLY operator (no documents:write/delete)', async () => {
    const { db } = await setup();

    // Seed a MEMBER user (the harness user is the owner).
    const memberId = nanoid();
    await db.insert(users).values({
      id: memberId,
      email: 'member@test.local',
      name: 'Mark',
      passwordHash: 'x',
      role: 'member',
    });

    const conv = await createConversation(db, {
      createdBy: memberId,
      operatorAgentId: '_operator',
      title: 'Untitled',
    });
    const runId = nanoid();
    await createConversationRun(db, {
      conversation: { id: conv.id, createdBy: memberId },
      runId,
    });

    const ctx = await loadContext(runId);
    expect(ctx).not.toBeNull();
    const scopes = ctx!.token.scopes;
    // A member's run authority is read+write docs only (roleToScopes(member)).
    expect(scopes).toContain('documents:read');
    expect(scopes).toContain('documents:write');
    // Denial path: a member NEVER gets delete / admin scopes via the operator.
    expect(scopes).not.toContain('documents:delete');
    expect(scopes).not.toContain('config:write');
    expect(scopes).not.toContain('workspace:admin');
    expect(scopes).not.toContain('members:write');
  });

  test('an OWNER-owned conversation yields the full operator scope set', async () => {
    const { db, seed } = await setup();
    const conv = await createConversation(db, {
      createdBy: seed.user.id,
      operatorAgentId: '_operator',
      title: 'Untitled',
    });
    const runId = nanoid();
    await createConversationRun(db, {
      conversation: { id: conv.id, createdBy: seed.user.id },
      runId,
    });

    const ctx = await loadContext(runId);
    expect(ctx).not.toBeNull();
    const scopes = new Set(ctx!.token.scopes);
    // Owner gets operator ∩ owner = every operator scope (owner has all scopes).
    for (const s of OPERATOR_SCOPES) expect(scopes.has(s)).toBe(true);
  });

  test('scopes NEVER exceed toolsToScopes(OPERATOR_TOOLS) regardless of role', async () => {
    const { db, seed } = await setup();
    const operatorScopeSet = new Set(OPERATOR_SCOPES);

    for (const [role, userId] of [
      ['owner', seed.user.id],
      ['member', await seedUser(db, 'member')],
      ['admin', await seedUser(db, 'admin')],
    ] as const) {
      const conv = await createConversation(db, {
        createdBy: userId,
        operatorAgentId: '_operator',
        title: 'Untitled',
      });
      const runId = nanoid();
      await createConversationRun(db, {
        conversation: { id: conv.id, createdBy: userId },
        runId,
      });
      const ctx = await loadContext(runId);
      // Every granted scope is a member of the operator's own scope set — the
      // operator can never exceed its tool whitelist even for an owner caller.
      for (const s of ctx!.token.scopes) {
        expect(operatorScopeSet.has(s)).toBe(true);
      }
      // And it is bounded by the caller role too (operator ∩ caller).
      const callerSet = new Set(roleToScopes(role));
      for (const s of ctx!.token.scopes) expect(callerSet.has(s)).toBe(true);
    }
  });

  test('non-owner project ceiling is bounded to the caller visible projects; owner → null', async () => {
    const { db, seed } = await setup();

    // Owner → null (no narrowing).
    const ownerConv = await createConversation(db, {
      createdBy: seed.user.id,
      operatorAgentId: '_operator',
      title: 'Untitled',
    });
    const ownerRunId = nanoid();
    await createConversationRun(db, {
      conversation: { id: ownerConv.id, createdBy: seed.user.id },
      runId: ownerRunId,
    });
    const ownerCtx = await loadContext(ownerRunId);
    // owner: projectIds null = no narrowing (operator ['*'] stands).
    expect(ownerCtx!.token.projectIds).toBeNull();

    // Member with a grant to ONE project in a second workspace.
    const memberId = await seedUser(db, 'member');
    const ws2 = nanoid();
    await db.insert(workspaces).values({ id: ws2, slug: 'beta', name: 'Beta' });
    const grantedProject = nanoid();
    const ungrantedProject = nanoid();
    await db.insert(projects).values([
      { id: grantedProject, workspaceId: ws2, slug: 'granted', name: 'Granted' },
      { id: ungrantedProject, workspaceId: ws2, slug: 'ungranted', name: 'Ungranted' },
    ]);
    await db.insert(projectAccess).values({ userId: memberId, projectId: grantedProject });

    const memberConv = await createConversation(db, {
      createdBy: memberId,
      operatorAgentId: '_operator',
      title: 'Untitled',
    });
    const memberRunId = nanoid();
    await createConversationRun(db, {
      conversation: { id: memberConv.id, createdBy: memberId },
      runId: memberRunId,
    });
    const memberCtx = await loadContext(memberRunId);
    // The ceiling = exactly the granted project; the ungranted sibling is excluded.
    expect(memberCtx!.token.projectIds).toEqual([grantedProject]);
  });

  // Cluster-3 /code-review fix: a WORKSPACE-grant holder (no per-project grants)
  // can see EVERY project in that workspace, so their operator's ceiling = all ws
  // projects — NOT deny-all. Before the canManageWorkspace branch, visibleProjectIds
  // (direct grants only) returned [], wedging the operator to write NOWHERE.
  // Bite: against the pre-fix loop this asserts [] and FAILS.
  test('a workspace-grant holder (no project grants) gets ALL workspace projects, not deny-all', async () => {
    const { db } = await setup();
    const memberId = await seedUser(db, 'member');
    const ws = nanoid();
    await db.insert(workspaces).values({ id: ws, slug: 'gamma', name: 'Gamma' });
    const p1 = nanoid();
    const p2 = nanoid();
    await db.insert(projects).values([
      { id: p1, workspaceId: ws, slug: 'p1', name: 'P1' },
      { id: p2, workspaceId: ws, slug: 'p2', name: 'P2' },
    ]);
    // Whole-workspace grant, NO project_access rows.
    await db.insert(workspaceAccess).values({ userId: memberId, workspaceId: ws });

    const conv = await createConversation(db, {
      createdBy: memberId,
      operatorAgentId: '_operator',
      title: 'Untitled',
    });
    const runId = nanoid();
    await createConversationRun(db, {
      conversation: { id: conv.id, createdBy: memberId },
      runId,
    });
    const ctx = await loadContext(runId);
    // Both ws projects are in the ceiling (order-independent); NOT [] (the bug).
    expect(new Set(ctx!.token.projectIds)).toEqual(new Set([p1, p2]));
  });
});

describe('createConversationRun → loadContext — end-to-end wiring (seam)', () => {
  test('a conversation run is loadable: RunContext has sink, conversationId, ephemeral token, NO parent', async () => {
    const { db, seed } = await setup();
    const conv = await createConversation(db, {
      createdBy: seed.user.id,
      operatorAgentId: '_operator',
      title: 'Untitled',
    });
    const runId = nanoid();
    await createConversationRun(db, {
      conversation: { id: conv.id, createdBy: seed.user.id },
      runId,
    });

    const ctx = await loadContext(runId);
    expect(ctx).not.toBeNull();
    // Sink + conversationId wired (the conversation output path).
    expect(ctx!.sink).toBeDefined();
    expect(ctx!.conversationId).toBe(conv.id);
    // Ephemeral operator token — never persisted; agentId is the synthetic id.
    expect(ctx!.token.agentId).toBe('operator:_operator');
    expect(ctx!.token.tokenHash.startsWith('ephemeral:')).toBe(true);
    // unattended is false — a human is present.
    expect(ctx!.unattended).toBe(false);
    // The agent is the operator; the toolset is the operator whitelist.
    expect(ctx!.agent.slug).toBe('_operator');
    expect(ctx!.agentFm.tools).toEqual([...OPERATOR_TOOLS]);
    // callerScopes === token.scopes so the executeTool double-membership holds.
    expect(ctx!.callerScopes).toEqual(ctx!.token.scopes);
  });

  test('a second loadContext for the same run id returns the document path (registry consumed once)', async () => {
    const { db, seed } = await setup();
    const conv = await createConversation(db, {
      createdBy: seed.user.id,
      operatorAgentId: '_operator',
      title: 'Untitled',
    });
    const runId = nanoid();
    await createConversationRun(db, {
      conversation: { id: conv.id, createdBy: seed.user.id },
      runId,
    });

    const first = await loadContext(runId);
    expect(first).not.toBeNull();
    // Consumed: the registry entry is gone, so a second load falls through to the
    // document path and finds no agent_run row → null (no double-spend).
    const second = await loadContext(runId);
    expect(second).toBeNull();
    __dropPendingConversationRunForTest(runId); // no-op (already consumed); hygiene
  });

  // review #8 (the BLOCKER #1 wiring test): the configured operator_model must
  // drive BOTH the streamed provider/model AND the AI-key + baseUrl resolution.
  // The pre-fix code set fm.provider/model from the setting but resolved the key
  // from the hardcoded (def.provider='anthropic', label='default') — so an ollama
  // operator fetched the anthropic credential and never used the ollama row's
  // baseUrl (threat-model M2). Bite: against the pre-fix lookup ctx.baseUrl is
  // undefined (anthropic row, or no row) and ctx.fm.ai_key_label is 'default'.
  test('the configured operator model drives provider/model AND the key+baseUrl lookup', async () => {
    const { db, seed } = await setup();
    // Seed an ollama key under a NON-'default' label with a (validated) baseUrl.
    await db.insert(aiKeys).values({
      id: nanoid(),
      provider: 'ollama',
      label: 'local',
      encryptedKey: encryptSecret(''), // ollama is keyless
      baseUrl: 'https://ollama.example.com',
    });
    await setOperatorModelSetting(db, {
      provider: 'ollama',
      model: 'llama3.1:8b',
      aiKeyLabel: 'local',
    });

    const conv = await createConversation(db, {
      createdBy: seed.user.id,
      operatorAgentId: '_operator',
      title: 'Untitled',
    });
    const runId = nanoid();
    await createConversationRun(db, {
      conversation: { id: conv.id, createdBy: seed.user.id },
      runId,
    });

    const ctx = await loadContext(runId);
    expect(ctx).not.toBeNull();
    // Provider/model/label come from the setting...
    expect(ctx!.fm.provider).toBe('ollama');
    expect(ctx!.fm.model).toBe('llama3.1:8b');
    expect(ctx!.fm.ai_key_label).toBe('local');
    // ...AND the key+baseUrl are resolved from THAT row (the #1 fix). baseUrl
    // from the ollama 'local' row — NOT undefined (which the wrong-row lookup gave).
    expect(ctx!.baseUrl).toBe('https://ollama.example.com');
  });

  test('with NO operator_model setting, the operator falls back to the anthropic default', async () => {
    const { db, seed } = await setup();
    const conv = await createConversation(db, {
      createdBy: seed.user.id,
      operatorAgentId: '_operator',
      title: 'Untitled',
    });
    const runId = nanoid();
    await createConversationRun(db, {
      conversation: { id: conv.id, createdBy: seed.user.id },
      runId,
    });
    const ctx = await loadContext(runId);
    expect(ctx!.fm.provider).toBe('anthropic');
    expect(ctx!.fm.ai_key_label).toBe('default');
  });
});

// Cluster-3 /code-review fix: the single-active-turn slot MUST be released on
// EVERY terminal path of a conversation run — including a blocking preflight
// (no AI key), which `return`s BEFORE the inner try/finally in the pre-fix code.
// setup() seeds NO ai_keys row, so the real runAgent hits conversationPreflight's
// no_ai_key block. Bite: against the pre-fix early-return the slot stays set and
// this assertion (activeRunId === null) FAILS — wedging the conversation at 409.
describe('conversation run — slot released on every terminal path (M14 wedge fix)', () => {
  test('a no-AI-key preflight block still clears active_run_id (not wedged)', async () => {
    const { db, seed } = await setup(); // no ai_keys seeded
    const conv = await createConversation(db, {
      createdBy: seed.user.id,
      operatorAgentId: '_operator',
      title: 'Untitled',
    });
    const runId = nanoid();
    await createConversationRun(db, {
      conversation: { id: conv.id, createdBy: seed.user.id },
      runId,
    });
    // Simulate the route's CAS acquire: the slot points at this run.
    await db.update(conversations).set({ activeRunId: runId }).where(eq(conversations.id, conv.id));

    // Real runAgent: loadContext (conversation branch) → conversationPreflight
    // blocks on the absent key → early return. The wrapping finally must still
    // clear the slot.
    await runAgent({ runId });

    const row = await db.query.conversations.findFirst({ where: eq(conversations.id, conv.id) });
    expect(row?.activeRunId).toBeNull(); // released — the conversation is NOT wedged
  });
});

async function seedUser(db: Awaited<ReturnType<typeof makeTestApp>>['db'], role: 'member' | 'admin'): Promise<string> {
  const id = nanoid();
  await db.insert(users).values({
    id,
    email: `${role}-${id}@test.local`,
    name: role,
    passwordHash: 'x',
    role,
  });
  return id;
}
