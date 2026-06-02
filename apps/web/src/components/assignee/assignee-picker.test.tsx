import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AssigneePicker } from './assignee-picker.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function stubFetch(handlers: Record<string, () => Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      for (const [match, build] of Object.entries(handlers)) {
        if (url.includes(match)) return build();
      }
      return new Response(JSON.stringify({ data: { members: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

const memberResponse = () =>
  new Response(
    JSON.stringify({
      data: {
        members: [
          { id: 'u1', email: 'alice@test', name: 'Alice', role: 'owner' },
          { id: 'u2', email: 'bob@test', name: 'Bob', role: 'member' },
        ],
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

// Phase 2.5: workspace-scoped agent list — single { data: [] } envelope.
const agentsResponse = () =>
  new Response(
    JSON.stringify({
      data: [
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
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

// useProjects(wslug) — needed so the picker can resolve pslug → project id.
const projectsResponse = () =>
  new Response(
    JSON.stringify({
      data: [
        { id: 'pid-web', workspaceId: 'w1', slug: 'web', name: 'Web', icon: null, description: null },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

describe('AssigneePicker', () => {
  it('renders sections for Members and Agents and lists each', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubFetch({
      '/documents?type=agent': agentsResponse, // workspace-scoped agents list
      '/projects': projectsResponse,            // useProjects lookup for pslug → id
      '/members': memberResponse,
    });
    render(
      <AssigneePicker wslug="acme" pslug="web" value="" onChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    await userEvent.click(screen.getByRole('button', { name: /unassigned/i }));

    expect(await screen.findByText(/members/i)).toBeInTheDocument();
    expect(screen.getByText(/agents/i)).toBeInTheDocument();
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(await screen.findByText('Triage Bot')).toBeInTheDocument();
  });

  it('clicking a member calls onChange with the email', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubFetch({
      '/documents?type=agent': agentsResponse, // workspace-scoped agents list
      '/projects': projectsResponse,            // useProjects lookup for pslug → id
      '/members': memberResponse,
    });
    const onChange = vi.fn();
    render(
      <AssigneePicker wslug="acme" pslug="web" value="" onChange={onChange} />,
      { wrapper: wrap(qc) },
    );
    await userEvent.click(screen.getByRole('button', { name: /unassigned/i }));
    await userEvent.click(await screen.findByRole('button', { name: /Alice alice@test/i }));
    expect(onChange).toHaveBeenCalledWith('alice@test');
  });

  it('clicking an agent calls onChange with agent:<slug>', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubFetch({
      '/documents?type=agent': agentsResponse, // workspace-scoped agents list
      '/projects': projectsResponse,            // useProjects lookup for pslug → id
      '/members': memberResponse,
    });
    const onChange = vi.fn();
    render(
      <AssigneePicker wslug="acme" pslug="web" value="" onChange={onChange} />,
      { wrapper: wrap(qc) },
    );
    await userEvent.click(screen.getByRole('button', { name: /unassigned/i }));
    await userEvent.click(await screen.findByRole('button', { name: /Triage Bot/i }));
    expect(onChange).toHaveBeenCalledWith('agent:triage-bot');
  });

  it('shows a "library" marker next to a __system agent (B8)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const mixedAgents = () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'd1', slug: 'triage-bot', type: 'agent', title: 'Triage Bot',
              status: null, parentId: null, library: false, frontmatter: { projects: ['*'] },
              createdAt: '', updatedAt: '', lastTouchedAt: null,
            },
            {
              id: 'op', slug: 'operator', type: 'agent', title: 'Operator',
              status: null, parentId: null, library: true, frontmatter: { projects: ['*'] },
              createdAt: '', updatedAt: '', lastTouchedAt: null,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    stubFetch({
      '/documents?type=agent': mixedAgents,
      '/projects': projectsResponse,
      '/members': memberResponse,
    });
    render(
      <AssigneePicker wslug="acme" pslug="web" value="" onChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    await userEvent.click(screen.getByRole('button', { name: /unassigned/i }));
    const libRow = await screen.findByRole('button', { name: /Operator/i });
    expect(within(libRow).getByText('library')).toBeInTheDocument();
    const localRow = screen.getByRole('button', { name: /Triage Bot/i });
    expect(within(localRow).queryByText('library')).not.toBeInTheDocument();
  });

  it('shows the current value in the trigger label', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubFetch({
      '/documents?type=agent': agentsResponse, // workspace-scoped agents list
      '/projects': projectsResponse,            // useProjects lookup for pslug → id
      '/members': memberResponse,
    });
    render(
      <AssigneePicker
        wslug="acme"
        pslug="web"
        value="agent:triage-bot"
        onChange={() => {}}
      />,
      { wrapper: wrap(qc) },
    );
    // Wait for agents to load so the label resolves to the friendly name.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /triage bot/i })).toBeInTheDocument();
    });
  });

  it('Unassign option clears the value to empty string', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubFetch({
      '/documents?type=agent': agentsResponse, // workspace-scoped agents list
      '/projects': projectsResponse,            // useProjects lookup for pslug → id
      '/members': memberResponse,
    });
    const onChange = vi.fn();
    render(
      <AssigneePicker
        wslug="acme"
        pslug="web"
        value="alice@test"
        onChange={onChange}
      />,
      { wrapper: wrap(qc) },
    );
    await userEvent.click(screen.getByRole('button', { name: /alice/i }));
    await userEvent.click(await screen.findByRole('button', { name: /clear assignee|unassign/i }));
    expect(onChange).toHaveBeenCalledWith('');
  });
});
