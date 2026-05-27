/**
 * Tests for the workspace-event visibility predicate used by SSE + REST.
 * Covers the H1/H2 false-positives + false-negatives that the prior
 * G9 kind-prefix check missed.
 */
import { describe, expect, test } from 'bun:test';
import { isAgentEventVisible } from './agent-event-visibility.ts';

const NON_AGENT = { agentId: null, agentSlug: null };
const AGENT_A = { agentId: 'agent-a-id', agentSlug: 'agent-a' };
const AGENT_B = { agentId: 'agent-b-id', agentSlug: 'agent-b' };

describe('isAgentEventVisible — non-agent tokens see everything', () => {
  test('session / human PAT sees workspace-level agent.created about another agent', () => {
    expect(
      isAgentEventVisible(NON_AGENT, {
        kind: 'agent.created',
        projectId: null,
        documentId: 'some-agent-id',
        payload: { slug: 'foo' },
      }),
    ).toBe(true);
  });
});

describe('isAgentEventVisible — project-scoped events bypass (F3 owns the call)', () => {
  test('project-scoped event always passes here; caller applies F3 allow-list', () => {
    expect(
      isAgentEventVisible(AGENT_A, {
        kind: 'document.created',
        projectId: 'proj-1',
        documentId: 'doc-1',
        payload: {},
      }),
    ).toBe(true);
  });
});

describe('isAgentEventVisible — workspace-level events about self', () => {
  test('agent.created about THIS agent → visible', () => {
    expect(
      isAgentEventVisible(AGENT_A, {
        kind: 'agent.created',
        projectId: null,
        documentId: AGENT_A.agentId,
        payload: { slug: 'agent-a', api_token_id: 'tok' },
      }),
    ).toBe(true);
  });

  test('agent.deleted about THIS agent → visible', () => {
    expect(
      isAgentEventVisible(AGENT_A, {
        kind: 'agent.deleted',
        projectId: null,
        documentId: AGENT_A.agentId,
        payload: { slug: 'agent-a' },
      }),
    ).toBe(true);
  });

  test('agent.allow_list.reconciled about THIS agent → visible', () => {
    expect(
      isAgentEventVisible(AGENT_A, {
        kind: 'agent.allow_list.reconciled',
        projectId: null,
        documentId: AGENT_A.agentId,
        payload: { agent_id: AGENT_A.agentId, removed_project_ids: ['p-old'] },
      }),
    ).toBe(true);
  });

  test('activity.logged on THIS agent → visible (operator notes for this agent are intended)', () => {
    expect(
      isAgentEventVisible(AGENT_A, {
        kind: 'activity.logged',
        projectId: null,
        documentId: AGENT_A.agentId,
        payload: { note: 'context' },
      }),
    ).toBe(true);
  });

  test('document.created for THIS agent doc (workspace-scoped agent doc) → visible', () => {
    expect(
      isAgentEventVisible(AGENT_A, {
        kind: 'document.created',
        projectId: null,
        documentId: AGENT_A.agentId,
        payload: { slug: 'agent-a', type: 'agent' },
      }),
    ).toBe(true);
  });
});

describe('isAgentEventVisible — workspace-level events about OTHER agents (H1/H2)', () => {
  test('H2: document.created for OTHER agent doc → hidden', () => {
    expect(
      isAgentEventVisible(AGENT_A, {
        kind: 'document.created',
        projectId: null,
        documentId: AGENT_B.agentId,
        payload: { slug: 'agent-b', type: 'agent' },
      }),
    ).toBe(false);
  });

  test('H2: activity.logged on OTHER agent → hidden (free-form note payload)', () => {
    expect(
      isAgentEventVisible(AGENT_A, {
        kind: 'activity.logged',
        projectId: null,
        documentId: AGENT_B.agentId,
        payload: { note: 'sensitive context about B' },
      }),
    ).toBe(false);
  });

  test('G9 still works: agent.created about OTHER agent → hidden', () => {
    expect(
      isAgentEventVisible(AGENT_A, {
        kind: 'agent.created',
        projectId: null,
        documentId: AGENT_B.agentId,
        payload: { slug: 'agent-b', api_token_id: 'sensitive-tok' },
      }),
    ).toBe(false);
  });

  test('G9 still works: agent.allow_list.reconciled about OTHER agent → hidden', () => {
    expect(
      isAgentEventVisible(AGENT_A, {
        kind: 'agent.allow_list.reconciled',
        projectId: null,
        documentId: AGENT_B.agentId,
        payload: { agent_id: AGENT_B.agentId, removed_project_ids: ['p-x'] },
      }),
    ).toBe(false);
  });
});

describe('isAgentEventVisible — H1: agent.task.assigned reaches the assignee', () => {
  test('agent.task.assigned with payload.agent === my slug → visible (project-scoped, F3 passes)', () => {
    expect(
      isAgentEventVisible(AGENT_A, {
        kind: 'agent.task.assigned',
        projectId: 'proj-1', // project-scoped, F3 owns the project allow-list
        documentId: 'work-item-id',
        payload: { slug: 'task-1', agent: AGENT_A.agentSlug },
      }),
    ).toBe(true);
  });

  test('agent.task.assigned with payload.agent === my slug AND projectId=null → visible (workspace-scoped variant)', () => {
    expect(
      isAgentEventVisible(AGENT_A, {
        kind: 'agent.task.assigned',
        projectId: null,
        documentId: 'work-item-id',
        payload: { slug: 'task-1', agent: AGENT_A.agentSlug },
      }),
    ).toBe(true);
  });

  test('agent.task.assigned with payload.agent === OTHER agent slug → hidden (workspace-scoped)', () => {
    expect(
      isAgentEventVisible(AGENT_A, {
        kind: 'agent.task.assigned',
        projectId: null,
        documentId: 'work-item-id',
        payload: { slug: 'task-1', agent: 'agent-b' },
      }),
    ).toBe(false);
  });
});

describe('isAgentEventVisible — workspace.* events about workspace itself', () => {
  test('workspace.created with no documentId → hidden from narrowed agent (strict policy)', () => {
    expect(
      isAgentEventVisible(AGENT_A, {
        kind: 'workspace.created',
        projectId: null,
        documentId: null,
        payload: { slug: 'ws', name: 'WS' },
      }),
    ).toBe(false);
  });

  test('workspace.updated → hidden from narrowed agent', () => {
    expect(
      isAgentEventVisible(AGENT_A, {
        kind: 'workspace.updated',
        projectId: null,
        documentId: null,
        payload: { changes: ['name'] },
      }),
    ).toBe(false);
  });
});
