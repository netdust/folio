/**
 * M2 Task 5 — the de-cycled leaf agent-identity resolver.
 *
 * This is the auth/identity convergence point invariant 13 names: token →
 * agent Document. The two call-shapes (throw-variant for the registry, soft
 * variant for the guards) share one core that checks the un-forgeable
 * `isOperator` marker FIRST (before the agentId branch), so the code-singleton
 * operator — which carries `agentId: null` + `isOperator: true` — resolves to
 * its definition rather than tripping the agent_missing path.
 *
 * Tier A (auth/identity path). RED-first; both denial shapes asserted.
 */

import { describe, expect, it } from 'bun:test';
import { nanoid } from 'nanoid';
import type { DB } from '../db/client.ts';
import { type ApiToken, type EphemeralToken, apiTokens, documents } from '../db/schema.ts';
import { makeTestApp } from '../test/harness.ts';
import { resolveAgentDocForToken, resolveCallingAgentDoc } from './agent-identity.ts';
import { newApiToken } from './auth.ts';
import { OPERATOR_AGENT_ID, OPERATOR_SLUG } from './operator.ts';

/** Seed a real agent Document + its bearer token, returns both ids. */
async function seedAgent(
  db: DB,
  workspaceId: string,
  userId: string,
): Promise<{ token: ApiToken; agentId: string; agentSlug: string }> {
  const agentId = nanoid();
  const agentSlug = `agent-${nanoid(6)}`;
  await db.insert(documents).values({
    id: agentId,
    projectId: null,
    workspaceId,
    tableId: null,
    type: 'agent',
    slug: agentSlug,
    title: 'Test Agent',
    status: null,
    body: 'help',
    frontmatter: {
      system_prompt: 'help',
      model: 'm',
      provider: 'anthropic',
      tools: ['list_documents'],
      projects: ['*'],
    },
    createdBy: userId,
    updatedBy: userId,
  });
  const { hash } = newApiToken();
  const tokenId = nanoid();
  await db.insert(apiTokens).values({
    id: tokenId,
    workspaceId,
    name: `agent:${agentSlug}`,
    tokenHash: hash,
    scopes: ['documents:read'],
    agentId,
    createdBy: userId,
  });
  const token = (await db.query.apiTokens.findFirst({ where: (t, { eq }) => eq(t.id, tokenId) }))!;
  return { token, agentId, agentSlug };
}

/** An ephemeral operator-marked token: agentId null, isOperator true (Shape B′). */
function operatorToken(): EphemeralToken {
  return {
    id: 'tok_op',
    workspaceId: null,
    name: 'operator',
    tokenHash: 'h',
    scopes: ['documents:read'],
    agentId: null,
    projectIds: null,
    createdBy: 'some-user', // the operator's createdBy is the CALLER, non-null
    lastUsedAt: null,
    expiresAt: null,
    createdAt: new Date(),
    isOperator: true,
  };
}

/** A token bound to an agent id whose row does not exist (stale / revoked). */
function staleAgentToken(): EphemeralToken {
  return {
    id: 'tok_stale',
    workspaceId: 'ws',
    name: 'stale',
    tokenHash: 'h',
    scopes: ['documents:read'],
    agentId: 'nonexistent-agent-id',
    projectIds: null,
    createdBy: 'u',
    lastUsedAt: null,
    expiresAt: null,
    createdAt: new Date(),
  };
}

describe('agent-identity leaf resolver (invariant 13)', () => {
  describe('M1 — operator marker is checked FIRST', () => {
    it('resolveAgentDocForToken resolves the operator doc (does NOT throw agent_missing)', async () => {
      await makeTestApp();
      const doc = await resolveAgentDocForToken(operatorToken());
      expect(doc.id).toBe(OPERATOR_AGENT_ID);
      expect(doc.slug).toBe(OPERATOR_SLUG);
    });

    it('resolveCallingAgentDoc resolves the operator doc (soft variant)', async () => {
      await makeTestApp();
      const doc = await resolveCallingAgentDoc(operatorToken());
      expect(doc?.id).toBe(OPERATOR_AGENT_ID);
    });
  });

  describe('M3 — throw vs soft denial shapes are distinguishable', () => {
    it('resolveAgentDocForToken THROWS agent_missing for a stale agent-bound token', async () => {
      await makeTestApp();
      let thrown: (Error & { code?: number; data?: { reason?: string } }) | undefined;
      try {
        await resolveAgentDocForToken(staleAgentToken());
      } catch (e) {
        thrown = e as Error & { code?: number; data?: { reason?: string } };
      }
      expect(thrown).toBeDefined();
      expect(thrown?.code).toBe(-32602);
      expect(thrown?.data?.reason).toBe('agent_missing');
    });

    it('resolveAgentDocForToken THROWS not_agent_bound for a token with no agentId', async () => {
      await makeTestApp();
      const humanPat: EphemeralToken = { ...staleAgentToken(), agentId: null };
      let thrown: (Error & { data?: { reason?: string } }) | undefined;
      try {
        await resolveAgentDocForToken(humanPat);
      } catch (e) {
        thrown = e as Error & { data?: { reason?: string } };
      }
      expect(thrown?.data?.reason).toBe('not_agent_bound');
    });

    it('resolveCallingAgentDoc returns undefined for a stale agent-bound token (soft)', async () => {
      await makeTestApp();
      const doc = await resolveCallingAgentDoc(staleAgentToken());
      expect(doc).toBeUndefined();
    });

    it('resolveCallingAgentDoc returns undefined for a token with no agentId (soft)', async () => {
      await makeTestApp();
      const humanPat: EphemeralToken = { ...staleAgentToken(), agentId: null };
      const doc = await resolveCallingAgentDoc(humanPat);
      expect(doc).toBeUndefined();
    });
  });

  describe('real agent-bound token resolves the seeded doc (both variants)', () => {
    it('resolveAgentDocForToken returns the seeded agent', async () => {
      const { db, seed } = await makeTestApp();
      const { token, agentId, agentSlug } = await seedAgent(db, seed.workspace.id, seed.user.id);
      const doc = await resolveAgentDocForToken(token as EphemeralToken);
      expect(doc.id).toBe(agentId);
      expect(doc.slug).toBe(agentSlug);
    });

    it('resolveCallingAgentDoc returns the seeded agent', async () => {
      const { db, seed } = await makeTestApp();
      const { token, agentId } = await seedAgent(db, seed.workspace.id, seed.user.id);
      const doc = await resolveCallingAgentDoc(token as EphemeralToken);
      expect(doc?.id).toBe(agentId);
    });
  });
});
