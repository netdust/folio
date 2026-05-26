import { describe, expect, it } from 'bun:test';
import { parseMentions } from './mention-parser.ts';

const agents = [
  { id: 'a-drafter', slug: 'drafter', allowedProjectIds: ['pr-a'] as string[] | ['*'] },
  { id: 'a-thread', slug: 'thread-helper', allowedProjectIds: ['*'] as string[] | ['*'] },
];
const members = [
  { id: 'u-1', email: 'jan@example.com' },
  { id: 'u-2', email: 'jan@otherco.com' }, // same localpart → ambiguous
  { id: 'u-3', email: 'stefan@netdust.be' },
];

describe('parseMentions', () => {
  it('matches @slug after whitespace, ignores emails mid-text', () => {
    const r = parseMentions({
      body: 'see @drafter — not jan@example.com',
      workspaceAgents: agents,
      workspaceMembers: members,
      currentProjectId: 'pr-a',
    });
    expect(r.mentions.map((m) => m.target)).toEqual(['agent:drafter']);
  });

  it('resolves agent in allow-list', () => {
    const r = parseMentions({
      body: '@drafter please',
      workspaceAgents: agents,
      workspaceMembers: members,
      currentProjectId: 'pr-a',
    });
    expect(r.mentions[0]).toMatchObject({
      target: 'agent:drafter',
      resolved: true,
      resolvedId: 'a-drafter',
      resolvedType: 'agent',
    });
  });

  it('marks agent unresolved when current project not in allow-list', () => {
    const r = parseMentions({
      body: '@drafter on this project',
      workspaceAgents: agents,
      workspaceMembers: members,
      currentProjectId: 'pr-other',
    });
    expect(r.mentions[0]).toMatchObject({ target: 'agent:drafter', resolved: false });
    expect(r.mentions[0].resolvedId).toBeUndefined();
  });

  it('resolves member by email localpart, unresolved on ambiguity', () => {
    const r = parseMentions({
      body: '@jan and @stefan',
      workspaceAgents: [],
      workspaceMembers: members,
      currentProjectId: 'pr-a',
    });
    const jan = r.mentions.find((m) => m.target.startsWith('user:') && m.resolved === false);
    expect(jan).toBeTruthy(); // ambiguous
    const stefan = r.mentions.find((m) => m.target === 'user:u-3');
    expect(stefan?.resolved).toBe(true);
  });

  it('detects approval at position 1', () => {
    const r = parseMentions({
      body: '@drafter approved — looks great',
      workspaceAgents: agents,
      workspaceMembers: members,
      currentProjectId: 'pr-a',
    });
    expect(r.approvalIntent).toEqual({
      kind: 'approval',
      targetAgent: 'drafter',
      targetAgentId: 'a-drafter',
    });
  });

  it('detects approval at position 2', () => {
    const r = parseMentions({
      body: '@drafter is approved',
      workspaceAgents: agents,
      workspaceMembers: members,
      currentProjectId: 'pr-a',
    });
    expect(r.approvalIntent?.kind).toBe('approval');
  });

  it('does NOT match approved at position 3+', () => {
    const r = parseMentions({
      body: '@drafter looks approved to me',
      workspaceAgents: agents,
      workspaceMembers: members,
      currentProjectId: 'pr-a',
    });
    expect(r.approvalIntent).toBeNull();
  });

  it('does NOT match the verb form "approve"', () => {
    const r = parseMentions({
      body: '@drafter please approve',
      workspaceAgents: agents,
      workspaceMembers: members,
      currentProjectId: 'pr-a',
    });
    expect(r.approvalIntent).toBeNull();
  });

  it('detects rejection and reports first match on multi-mention', () => {
    const r = parseMentions({
      body: '@drafter rejected; also @thread-helper approved',
      workspaceAgents: agents,
      workspaceMembers: members,
      currentProjectId: 'pr-a',
    });
    expect(r.approvalIntent).toEqual({
      kind: 'rejection',
      targetAgent: 'drafter',
      targetAgentId: 'a-drafter',
    });
  });

  it('deduplicates mentions by target', () => {
    const r = parseMentions({
      body: '@drafter please @drafter again',
      workspaceAgents: agents,
      workspaceMembers: members,
      currentProjectId: 'pr-a',
    });
    expect(r.mentions.length).toBe(1);
  });
});
