// Shared test fixtures for the AssigneePicker and its consumers (e.g. the
// table assignee cell). Both test files mount the picker, which fetches
// members + projects + workspace agents, so they need the same QueryClient
// wrapper, fetch stub, and wire-shaped responses. Kept here so the two test
// files don't re-create ~50 lines of identical fixtures.
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { vi } from 'vitest';

export function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** GET /members → { data: { members: [...] } } (Alice owner, Bob member). */
export const memberResponse = () =>
  json({
    members: [
      { id: 'u1', email: 'alice@test', name: 'Alice', role: 'owner' },
      { id: 'u2', email: 'bob@test', name: 'Bob', role: 'member' },
    ],
  });

/** Workspace-scoped agent list → { data: [...] } (single Triage Bot). */
export const agentsResponse = () =>
  json([
    {
      id: 'd1',
      slug: 'triage-bot',
      type: 'agent',
      title: 'Triage Bot',
      status: null,
      parentId: null,
      frontmatter: { projects: ['*'] },
      createdAt: '2026-05-25T00:00:00.000Z',
      updatedAt: '2026-05-25T00:00:00.000Z',
      lastTouchedAt: null,
    },
  ]);

/** useProjects(wslug) → { data: [...] } so the picker resolves pslug → id. */
export const projectsResponse = () =>
  json([
    { id: 'pid-web', workspaceId: 'w1', slug: 'web', name: 'Web', icon: null, description: null },
  ]);

/** The standard handler map covering every request the picker makes. */
export function assigneeHandlers(): Record<string, () => Response> {
  return {
    '/documents?type=agent': agentsResponse,
    '/projects': projectsResponse,
    '/members': memberResponse,
  };
}

/**
 * Stub global fetch with a URL-substring → Response handler map. Unmatched
 * URLs fall back to an empty members envelope (harmless for these tests).
 */
export function stubFetch(handlers: Record<string, () => Response> = assigneeHandlers()) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      for (const [match, build] of Object.entries(handlers)) {
        if (url.includes(match)) return build();
      }
      return json({ members: [] });
    }),
  );
}
