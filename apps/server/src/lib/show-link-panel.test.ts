/**
 * show_link_panel server-side VALIDATION + CANONICALIZATION (code-review #1/#4/#5).
 *
 * The handler resolves a document/work_item target against the caller-scoped
 * (workspace, project, slug) lookup and writes back the REAL slug + project slug,
 * so the rendered link can never dead-end:
 *   - a UUID-as-entityId (the slug lookup misses) → the tool ERRORS (no card),
 *   - a wrong pslug (doc not in that project) → the tool ERRORS (no card),
 *   - a valid slug → the emitted target carries the canonical slug + pslug.
 *
 * These bite: against the pre-fix handler (which forwarded args.target verbatim)
 * the UUID/wrong-pslug cases emitted a card that navigated nowhere.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { nanoid } from 'nanoid';
import { documents, type ApiToken } from '../db/schema.ts';
import { makeTestApp } from '../test/harness.ts';
import type { DB } from '../db/client.ts';
import { executeTool } from './agent-tools.ts';
import type { ConversationSink } from './chat-thread-sink.ts';
import type { Workspace, Project } from '../db/schema.ts';

let db: DB;
let ws: Workspace;
let project: Project;

function ownerToken(): ApiToken {
  return {
    id: 'tok_test',
    workspaceId: null,
    name: 'test',
    tokenHash: 'hash',
    scopes: ['documents:read'],
    agentId: null, // human/owner principal — no agent narrowing
    projectIds: null,
    createdBy: null,
    lastUsedAt: null,
    expiresAt: null,
    createdAt: new Date(),
  };
}

function recordingSink(): ConversationSink & { components: Record<string, unknown>[] } {
  const components: Record<string, unknown>[] = [];
  return {
    components,
    async text() {},
    async toolStep() {},
    async component(payload) {
      components.push(payload);
    },
  };
}

async function insertWorkItem(slug: string): Promise<void> {
  await db.insert(documents).values({
    id: nanoid(),
    projectId: project.id,
    workspaceId: ws.id,
    type: 'work_item',
    slug,
    title: 'Onboard Acme',
    status: null,
    body: '',
  });
}

beforeEach(async () => {
  const app = await makeTestApp();
  db = app.db;
  ws = app.seed.workspace;
  project = app.seed.project;
});

afterEach(() => {
  // makeTestApp wires a fresh in-memory db per call; nothing to tear down.
});

describe('show_link_panel server-derive', () => {
  test('a valid work_item slug → emits a card with the canonical slug + pslug', async () => {
    await insertWorkItem('onboard-acme');
    const sink = recordingSink();
    await executeTool(
      ownerToken(),
      'user-1',
      'show_link_panel',
      {
        target: { entityType: 'work_item', entityId: 'onboard-acme', wslug: ws.slug, pslug: project.slug },
        title: 'Onboard Acme',
      },
      undefined,
      { callerScopes: ['documents:read'], conversationSink: sink },
    );
    expect(sink.components).toHaveLength(1);
    const target = (sink.components[0] as { target: Record<string, string> }).target;
    expect(target.entityId).toBe('onboard-acme'); // canonical slug
    expect(target.pslug).toBe(project.slug);
  });

  test('a UUID passed as entityId (not the slug) → tool errors, no card', async () => {
    await insertWorkItem('onboard-acme');
    const sink = recordingSink();
    await expect(
      executeTool(
        ownerToken(),
        'user-1',
        'show_link_panel',
        {
          target: { entityType: 'work_item', entityId: crypto.randomUUID(), wslug: ws.slug, pslug: project.slug },
          title: 'Onboard Acme',
        },
        undefined,
        { callerScopes: ['documents:read'], conversationSink: sink },
      ),
    ).rejects.toThrow(/not found/i);
    expect(sink.components).toHaveLength(0);
  });

  test('a wrong pslug (doc not in that project) → tool errors, no card', async () => {
    await insertWorkItem('onboard-acme');
    const sink = recordingSink();
    await expect(
      executeTool(
        ownerToken(),
        'user-1',
        'show_link_panel',
        {
          target: { entityType: 'work_item', entityId: 'onboard-acme', wslug: ws.slug, pslug: 'no-such-project' },
          title: 'Onboard Acme',
        },
        undefined,
        { callerScopes: ['documents:read'], conversationSink: sink },
      ),
    ).rejects.toThrow();
    expect(sink.components).toHaveLength(0);
  });
});
