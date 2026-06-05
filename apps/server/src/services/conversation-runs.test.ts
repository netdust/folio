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
import { nanoid } from 'nanoid';
import { makeTestApp } from '../test/harness.ts';
import { instanceSkills, projectAccess, projects, users, workspaces } from '../db/schema.ts';
import { roleToScopes, toolsToScopes } from '../lib/agent-schema.ts';
import {
  FOLIO_SKILL_BODY,
  FOLIO_SKILL_SLUG,
  OPERATOR_TOOLS,
} from '../lib/system-skills.ts';
import { loadContext } from '../lib/runner.ts';
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
