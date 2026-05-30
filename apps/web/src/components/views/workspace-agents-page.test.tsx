import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// Stub TanStack Router's useNavigate + useSearch. The slideover mounts on this
// page and reads ?doc=<slug>; stub useSearch to return empty so the slideover
// stays closed during the listing-focused tests.
const navigateMock = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
  useSearch: () => ({}),
}));

import { WorkspaceAgentsPage } from './workspace-agents-page.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
  navigateMock.mockReset();
});

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const projects = [
  { id: 'p-a', workspaceId: 'w', slug: 'web', name: 'Website', icon: null, description: null },
  { id: 'p-b', workspaceId: 'w', slug: 'inbox', name: 'Inbox', icon: null, description: null },
];

const agents = [
  {
    id: 'a1',
    slug: 'triage',
    type: 'agent',
    title: 'Triage Bot',
    status: null,
    parentId: null,
    frontmatter: { projects: ['p-a', 'p-b'] },
    createdAt: '2026-01-01',
    updatedAt: '2026-01-02',
    lastTouchedAt: null,
  },
  {
    id: 'a2',
    slug: 'allbot',
    type: 'agent',
    title: 'All Bot',
    status: null,
    parentId: null,
    frontmatter: { projects: ['*'] },
    createdAt: '2026-01-01',
    updatedAt: '2026-01-02',
    lastTouchedAt: null,
  },
];

function stubFetch(opts: { agentsForFilter?: (project: string | null) => typeof agents } = {}) {
  const agentsFor =
    opts.agentsForFilter ??
    ((project) =>
      project
        ? agents.filter((a) => {
            const projs = (a.frontmatter as { projects: string[] }).projects;
            return projs.includes('*') || projs.includes(project);
          })
        : agents);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo) => {
      const url = new URL(String(input), 'http://x');
      if (url.pathname === '/api/v1/w/ws/projects') {
        return new Response(JSON.stringify({ data: projects }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname === '/api/v1/w/ws/documents' && url.searchParams.get('type') === 'agent') {
        const project = url.searchParams.get('project');
        return new Response(JSON.stringify({ data: agentsFor(project) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }),
  );
}

describe('WorkspaceAgentsPage', () => {
  it('renders agents with project chips (wildcard → "All projects" muted chip)', async () => {
    stubFetch();
    render(<WorkspaceAgentsPage wslug="ws" />, { wrapper: wrap(newQc()) });
    expect(await screen.findByText('Triage Bot')).toBeInTheDocument();
    expect(screen.getByText('All Bot')).toBeInTheDocument();
    // Wildcard agent renders the "All projects" chip.
    expect(screen.getByText('All projects')).toBeInTheDocument();
    // Specific agent renders project names (id → current slug lookup).
    expect(screen.getByText('Website')).toBeInTheDocument();
    expect(screen.getByText('Inbox')).toBeInTheDocument();
  });

  it('clicking a project chip navigates with ?project=<id>', async () => {
    stubFetch();
    render(<WorkspaceAgentsPage wslug="ws" />, { wrapper: wrap(newQc()) });
    const chip = await screen.findByText('Website');
    await userEvent.click(chip);
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/w/$wslug/agents',
      params: { wslug: 'ws' },
      search: { project: 'p-a' },
    });
  });

  it('clicking the agent row navigates with ?doc=<slug>', async () => {
    stubFetch();
    render(<WorkspaceAgentsPage wslug="ws" />, { wrapper: wrap(newQc()) });
    const row = await screen.findByText('Triage Bot');
    await userEvent.click(row);
    expect(navigateMock).toHaveBeenCalledTimes(1);
    const call = navigateMock.mock.calls[0]![0] as { search: (prev: unknown) => unknown };
    const search = call.search({});
    expect(search).toEqual({ doc: 'triage' });
  });

  it('with projectFilter set, shows a "Filtered to X" pill with a clear button', async () => {
    stubFetch();
    render(<WorkspaceAgentsPage wslug="ws" projectFilter="p-a" />, { wrapper: wrap(newQc()) });
    await waitFor(() => expect(screen.getByText(/Filtered to/)).toBeInTheDocument());
    // "Website" appears twice (the pill + the agent chip); we just care that the
    // agent listing includes it via the chip.
    expect(screen.getAllByText('Website').length).toBeGreaterThanOrEqual(1);
    await userEvent.click(screen.getByRole('button', { name: 'clear' }));
    expect(navigateMock).toHaveBeenCalledWith({
      to: '/w/$wslug/agents',
      params: { wslug: 'ws' },
      search: {},
    });
  });

  it('orphan project ids render as muted "<prefix>·removed" chips', async () => {
    stubFetch({
      agentsForFilter: () => [
        {
          ...agents[0],
          frontmatter: { projects: ['deadbeef-id-no-longer-exists', 'p-b'] },
        },
      ],
    });
    render(<WorkspaceAgentsPage wslug="ws" />, { wrapper: wrap(newQc()) });
    expect(await screen.findByText(/·removed/)).toBeInTheDocument();
    // The valid id still renders as a real chip.
    expect(screen.getByText('Inbox')).toBeInTheDocument();
  });

  it('shows the empty state when no agents exist', async () => {
    stubFetch({ agentsForFilter: () => [] });
    render(<WorkspaceAgentsPage wslug="ws" />, { wrapper: wrap(newQc()) });
    expect(await screen.findByText('No agents yet.')).toBeInTheDocument();
  });
});

// --- BUG-004 regression: page exposes create + slideover affordances ---

describe('WorkspaceAgentsPage — create + open affordances', () => {
  it('renders a "+ New agent" button in the header', async () => {
    stubFetch();
    render(<WorkspaceAgentsPage wslug="ws" />, { wrapper: wrap(newQc()) });
    await screen.findByText('Triage Bot'); // wait for the list
    expect(screen.getByRole('button', { name: /new agent/i })).toBeInTheDocument();
  });

  it('"+ New agent" POSTs to /api/v1/w/:wslug/documents and navigates with ?doc=', async () => {
    let postBody: Record<string, unknown> | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const url = new URL(String(input), 'http://x');
        if (init?.method === 'POST' && url.pathname === '/api/v1/w/ws/documents') {
          postBody = JSON.parse(init.body as string);
          return new Response(
            JSON.stringify({
              data: {
                id: 'new-agent-id',
                slug: 'untitled',
                type: 'agent',
                title: 'Untitled',
                frontmatter: { projects: ['*'] },
              },
            }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.pathname === '/api/v1/w/ws/projects') {
          return new Response(JSON.stringify({ data: projects }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.pathname === '/api/v1/w/ws/documents' && url.searchParams.get('type') === 'agent') {
          return new Response(JSON.stringify({ data: agents }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
      }),
    );
    render(<WorkspaceAgentsPage wslug="ws" />, { wrapper: wrap(newQc()) });
    await screen.findByText('Triage Bot');
    await userEvent.click(screen.getByRole('button', { name: /new agent/i }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalled());

    expect(postBody).not.toBeNull();
    expect((postBody as Record<string, unknown>).type).toBe('agent');
    expect((postBody as Record<string, unknown>).title).toBe('Untitled');

    const lastCall = navigateMock.mock.calls[navigateMock.mock.calls.length - 1]![0] as {
      search: (prev: unknown) => unknown;
    };
    const search = lastCall.search({});
    expect(search).toEqual({ doc: 'untitled' });
  });

  it('empty state surfaces a "+ New agent" CTA (when no filter is active)', async () => {
    stubFetch({ agentsForFilter: () => [] });
    render(<WorkspaceAgentsPage wslug="ws" />, { wrapper: wrap(newQc()) });
    await screen.findByText('No agents yet.');
    const buttons = screen.getAllByRole('button', { name: /new agent/i });
    expect(buttons.length).toBeGreaterThanOrEqual(2); // header + empty state
  });

  it('mounts the WorkspaceDocumentSlideover (Sheet stays closed when ?doc is absent)', async () => {
    stubFetch();
    const { container } = render(<WorkspaceAgentsPage wslug="ws" />, { wrapper: wrap(newQc()) });
    await screen.findByText('Triage Bot');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});

// --- Page-level tabs (Agents | Activity | Run) ---

// The Activity tab mounts ActivityFeedScreen, which opens an EventSource. Stub
// it with a no-op (copied from activity-feed-screen.test.tsx) so the feed mounts
// cleanly with an empty state.
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }
  addEventListener(t: string, fn: (e: MessageEvent) => void) {
    const a = this.listeners.get(t) ?? [];
    a.push(fn);
    this.listeners.set(t, a);
  }
  removeEventListener() {}
  close() {}
}

describe('WorkspaceAgentsPage — page tabs', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
  });

  it('renders the three page tabs', async () => {
    stubFetch();
    render(<WorkspaceAgentsPage wslug="ws" />, { wrapper: wrap(newQc()) });
    await screen.findByText('Triage Bot');
    expect(screen.getByRole('button', { name: 'Agents' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument();
  });

  it('the Agents tab shows the list + "New agent" button by default', async () => {
    stubFetch();
    render(<WorkspaceAgentsPage wslug="ws" />, { wrapper: wrap(newQc()) });
    expect(await screen.findByText('Triage Bot')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /new agent/i })).toBeInTheDocument();
  });

  it('clicking the Activity tab shows the activity feed (and hides the list)', async () => {
    stubFetch();
    render(<WorkspaceAgentsPage wslug="ws" />, { wrapper: wrap(newQc()) });
    await screen.findByText('Triage Bot');
    await userEvent.click(screen.getByRole('button', { name: 'Activity' }));
    expect(await screen.findByText(/no recent agent activity/i)).toBeInTheDocument();
    expect(screen.queryByText('Triage Bot')).toBeNull();
    // The feed opened a live SSE channel.
    expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(1);
  });

  it('clicking the Run tab shows the run launcher', async () => {
    stubFetch();
    render(<WorkspaceAgentsPage wslug="ws" />, { wrapper: wrap(newQc()) });
    await screen.findByText('Triage Bot');
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByText('Target document')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run agent/i })).toBeInTheDocument();
  });

  it('initialView="run" opens directly on the Run tab', async () => {
    stubFetch();
    render(<WorkspaceAgentsPage wslug="ws" initialView="run" />, { wrapper: wrap(newQc()) });
    expect(await screen.findByText('Target document')).toBeInTheDocument();
    // The agents list is not shown.
    expect(screen.queryByText('Triage Bot')).toBeNull();
  });

  it('changing tabs reflects the new view in the URL via navigate(?view=)', async () => {
    stubFetch();
    render(<WorkspaceAgentsPage wslug="ws" />, { wrapper: wrap(newQc()) });
    await screen.findByText('Triage Bot');
    await userEvent.click(screen.getByRole('button', { name: 'Activity' }));
    const call = navigateMock.mock.calls.find(
      (c) => (c[0] as { to?: string }).to === '/w/$wslug/agents' && typeof (c[0] as { search?: unknown }).search === 'function',
    )!;
    const search = (call[0] as { search: (prev: unknown) => unknown }).search({ project: 'p-a' });
    expect(search).toEqual({ project: 'p-a', view: 'activity' });
  });
});
