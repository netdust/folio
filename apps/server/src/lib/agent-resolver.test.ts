import { describe, expect, test } from 'bun:test';
import { nanoid } from 'nanoid';
import { makeTestApp } from '../test/harness.ts';
import { documents, workspaces } from '../db/schema.ts';
import { resolveAgentForRun } from './agent-resolver.ts';
import { OPERATOR_SLUG } from './operator.ts';
import { resolveAgentProjects, intersectAgentProjects } from './agent-projects.ts';

/**
 * §8.1 agent-run-authority — the mandatory regression test for the resolver
 * collapse. The three boundaries that stay REAL after tenancy is dropped:
 *   (1) a custom agent is bounded to its frontmatter.projects (invariant 3),
 *   (2) caller-bounded authority clamps to the caller ∩ agent ceiling,
 *   (3) the operator slug resolves to the CODE singleton, not a same-slug row
 *       (anti-impersonation, spec §4.5).
 */
describe('§8.1 agent-run-authority (resolver collapse)', () => {
  test('a custom agent cannot act on a project off its frontmatter.projects allow-list (invariant 3)', async () => {
    const { db, seed } = await makeTestApp();
    // An agent allow-listed to ONE project only.
    await db.insert(documents).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      projectId: null,
      type: 'agent',
      slug: 'scoped',
      title: 'scoped',
      status: null,
      body: 'do work',
      frontmatter: { projects: [seed.project.id] },
      createdBy: seed.user.id,
    });
    const agent = (await resolveAgentForRun(db, 'scoped'))!;
    expect(agent).toBeDefined();
    const allow = resolveAgentProjects(agent);
    expect(allow).toEqual([seed.project.id]);
    // The ceiling does NOT include a different project id.
    expect(intersectAgentProjects(allow, ['other-project-id'])).toEqual([]);
    // …and DOES include its own.
    expect(intersectAgentProjects(allow, [seed.project.id])).toEqual([seed.project.id]);
  });

  test('caller-bounded authority: agent ∩ caller is the effective project set', async () => {
    const { db, seed } = await makeTestApp();
    await db.insert(documents).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      projectId: null,
      type: 'agent',
      slug: 'wide',
      title: 'wide',
      status: null,
      body: 'do work',
      frontmatter: { projects: ['*'] }, // agent allows all
      createdBy: seed.user.id,
    });
    const agent = (await resolveAgentForRun(db, 'wide'))!;
    const allow = resolveAgentProjects(agent);
    // A caller narrowed to one project clamps the wide agent to that project.
    expect(intersectAgentProjects(allow, [seed.project.id])).toEqual([seed.project.id]);
  });

  test('the operator slug resolves to the code singleton, NOT a same-slug documents row (anti-impersonation)', async () => {
    const { db, seed } = await makeTestApp();
    // A malicious user manages to insert an agent row bearing the operator slug
    // (creation is blocked by isReservedSlug, but prove the resolver is safe even
    // if a row existed).
    await db.insert(documents).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      projectId: null,
      type: 'agent',
      slug: OPERATOR_SLUG,
      title: 'impostor',
      status: null,
      body: 'IMPOSTOR PROMPT — should never be used',
      frontmatter: { projects: ['*'], tools: ['create_document'] },
      createdBy: seed.user.id,
    });
    const resolved = (await resolveAgentForRun(db, OPERATOR_SLUG))!;
    // The resolver returns the CODE singleton — the impostor row's body/id are
    // never surfaced.
    expect(resolved.body).not.toContain('IMPOSTOR');
    expect(resolved.body).toContain('Folio operator');
    expect(resolved.id).toBe(`operator:${OPERATOR_SLUG}`);
    expect((resolved.frontmatter as { tools?: string[] }).tools).toContain('folio_api');
  });

  test('a custom agent resolves instance-wide by slug (no workspace predicate)', async () => {
    const { db, seed } = await makeTestApp();
    await db.insert(documents).values({
      id: nanoid(),
      workspaceId: seed.workspace.id,
      projectId: null,
      type: 'agent',
      slug: 'researcher',
      title: 'researcher',
      status: null,
      body: 'research',
      frontmatter: { projects: ['*'] },
      createdBy: seed.user.id,
    });
    const agent = await resolveAgentForRun(db, 'researcher');
    expect(agent?.slug).toBe('researcher');
    // A speculative slug doesn't resolve.
    expect(await resolveAgentForRun(db, 'no-such-agent')).toBeUndefined();
  });

  test('a cross-workspace slug collision still resolves (first match) + warns', async () => {
    const { db, seed } = await makeTestApp();
    // Two workspaces each define an agent with the SAME slug (DB only enforces
    // per-workspace slug uniqueness). Resolution must still return an agent (not
    // crash), and warn that the slug is ambiguous.
    const otherWs = nanoid();
    await db.insert(workspaces).values({ id: otherWs, slug: `other-${otherWs}`, name: 'Other' });
    const mk = (wsId: string) => ({
      id: nanoid(),
      workspaceId: wsId,
      projectId: null,
      type: 'agent' as const,
      slug: 'dupe',
      title: 'dupe',
      status: null,
      body: 'x',
      frontmatter: { projects: ['*'] },
      createdBy: seed.user.id,
    });
    await db.insert(documents).values(mk(seed.workspace.id));
    await db.insert(documents).values(mk(otherWs));

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => warnings.push(a.map(String).join(' '));
    try {
      const agent = await resolveAgentForRun(db, 'dupe');
      expect(agent?.slug).toBe('dupe'); // resolves, doesn't crash
    } finally {
      console.warn = origWarn;
    }
    expect(warnings.some((w) => /more than one workspace|instance-global/i.test(w))).toBe(true);
  });
});
