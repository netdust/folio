import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MentionPicker } from './mention-picker.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function makeQC() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function stubFetch(handlers: Record<string, () => Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      for (const [match, build] of Object.entries(handlers)) {
        if (url.includes(match)) return build();
      }
      // Default empty responses
      if (url.includes('/members')) {
        return new Response(JSON.stringify({ data: { members: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

// Helper to build an agent DocumentSummary
function makeAgent(slug: string, title: string, id = slug, library = false) {
  return {
    id,
    slug,
    type: 'agent' as const,
    title,
    status: null,
    parentId: null,
    library,
    frontmatter: { projects: ['*'] },
    createdAt: '2026-05-26T00:00:00.000Z',
    updatedAt: '2026-05-26T00:00:00.000Z',
    lastTouchedAt: null,
  };
}

function makeAgentsResponse(agents: ReturnType<typeof makeAgent>[]) {
  return () =>
    new Response(JSON.stringify({ data: agents }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

function makeMembersResponse(members: { id: string; email: string; name: string; role: string }[]) {
  return () =>
    new Response(JSON.stringify({ data: { members } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

const defaultAgents = [
  makeAgent('drafter', 'Reply Drafter'),
  makeAgent('helper', 'Thread Helper'),
];

const defaultMembers = [
  { id: 'u1', email: 'jan@example.com', name: 'Jan Doe', role: 'member' },
  { id: 'u2', email: 'stefan@netdust.be', name: 'Stefan V', role: 'owner' },
];

describe('MentionPicker', () => {
  it('renders AGENTS section with allow-list-filtered agents', async () => {
    const qc = makeQC();
    stubFetch({
      '/documents?type=agent': makeAgentsResponse(defaultAgents),
      '/members': makeMembersResponse(defaultMembers),
    });

    render(
      <MentionPicker
        workspaceSlug="acme"
        projectId="pid-1"
        query=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    // Section header
    expect(screen.getByText('AGENTS')).toBeInTheDocument();
    // Agent rows (emoji + name are sibling text nodes; use regex)
    expect(await screen.findByText(/Reply Drafter/)).toBeInTheDocument();
    expect(screen.getByText(/Thread Helper/)).toBeInTheDocument();
    // agent:<slug> secondary lines (also split across text nodes)
    expect(screen.getAllByText(/agent:drafter/)[0]).toBeInTheDocument();
    expect(screen.getAllByText(/agent:helper/)[0]).toBeInTheDocument();
  });

  it('renders MEMBERS section with workspace members', async () => {
    const qc = makeQC();
    stubFetch({
      '/documents?type=agent': makeAgentsResponse(defaultAgents),
      '/members': makeMembersResponse(defaultMembers),
    });

    render(
      <MentionPicker
        workspaceSlug="acme"
        projectId="pid-1"
        query=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    expect(screen.getByText('MEMBERS')).toBeInTheDocument();
    expect(await screen.findByText(/Jan Doe/)).toBeInTheDocument();
    expect(screen.getByText(/Stefan V/)).toBeInTheDocument();
    expect(screen.getByText('jan@example.com')).toBeInTheDocument();
    expect(screen.getByText('stefan@netdust.be')).toBeInTheDocument();
  });

  it('filters by query — matches agent slug (case-insensitive)', async () => {
    const qc = makeQC();
    stubFetch({
      '/documents?type=agent': makeAgentsResponse(defaultAgents),
      '/members': makeMembersResponse(defaultMembers),
    });

    render(
      <MentionPicker
        workspaceSlug="acme"
        projectId="pid-1"
        query="draft"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    expect(await screen.findByText(/Reply Drafter/)).toBeInTheDocument();
    expect(screen.queryByText(/Thread Helper/)).not.toBeInTheDocument();
  });

  it('filters by query — matches agent title (case-insensitive)', async () => {
    const qc = makeQC();
    stubFetch({
      '/documents?type=agent': makeAgentsResponse(defaultAgents),
      '/members': makeMembersResponse(defaultMembers),
    });

    render(
      <MentionPicker
        workspaceSlug="acme"
        projectId="pid-1"
        query="thread"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    expect(await screen.findByText(/Thread Helper/)).toBeInTheDocument();
    expect(screen.queryByText(/Reply Drafter/)).not.toBeInTheDocument();
  });

  it('filters by query — matches member email localpart (case-insensitive)', async () => {
    const qc = makeQC();
    stubFetch({
      '/documents?type=agent': makeAgentsResponse(defaultAgents),
      '/members': makeMembersResponse(defaultMembers),
    });

    render(
      <MentionPicker
        workspaceSlug="acme"
        projectId="pid-1"
        query="stef"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    expect(await screen.findByText(/Stefan V/)).toBeInTheDocument();
    expect(screen.queryByText(/Jan Doe/)).not.toBeInTheDocument();
  });

  it('filters by query — matches member name (case-insensitive)', async () => {
    const qc = makeQC();
    stubFetch({
      '/documents?type=agent': makeAgentsResponse(defaultAgents),
      '/members': makeMembersResponse(defaultMembers),
    });

    render(
      <MentionPicker
        workspaceSlug="acme"
        projectId="pid-1"
        query="jan"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    expect(await screen.findByText(/Jan Doe/)).toBeInTheDocument();
    expect(screen.queryByText(/Stefan V/)).not.toBeInTheDocument();
  });

  it('arrow-down + arrow-up moves selection across both sections', async () => {
    const qc = makeQC();
    stubFetch({
      '/documents?type=agent': makeAgentsResponse(defaultAgents),
      '/members': makeMembersResponse(defaultMembers),
    });

    render(
      <MentionPicker
        workspaceSlug="acme"
        projectId="pid-1"
        query=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    // Wait for data to load
    await screen.findByText(/Reply Drafter/);

    const listbox = screen.getByRole('listbox');

    // Initially index 0 (first agent) is selected
    const agentOptions = screen.getAllByRole('option');
    expect(agentOptions[0]).toHaveAttribute('aria-selected', 'true');

    // ArrowDown → index 1 (second agent)
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');

    // ArrowDown → index 2 (first member)
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true');

    // ArrowUp → back to index 1 (second agent)
    fireEvent.keyDown(listbox, { key: 'ArrowUp' });
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('Enter selects highlighted row', async () => {
    const onSelect = vi.fn();
    const qc = makeQC();
    stubFetch({
      '/documents?type=agent': makeAgentsResponse(defaultAgents),
      '/members': makeMembersResponse(defaultMembers),
    });

    render(
      <MentionPicker
        workspaceSlug="acme"
        projectId="pid-1"
        query=""
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    await screen.findByText('Reply Drafter');

    const listbox = screen.getByRole('listbox');

    // Move to second row (index 1 = second agent)
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith({ type: 'agent', value: 'helper' });
  });

  it('Escape calls onClose', async () => {
    const onClose = vi.fn();
    const qc = makeQC();
    stubFetch({
      '/documents?type=agent': makeAgentsResponse(defaultAgents),
      '/members': makeMembersResponse(defaultMembers),
    });

    render(
      <MentionPicker
        workspaceSlug="acme"
        projectId="pid-1"
        query=""
        onSelect={vi.fn()}
        onClose={onClose}
      />,
      { wrapper: wrap(qc) },
    );

    const listbox = screen.getByRole('listbox');
    fireEvent.keyDown(listbox, { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });

  it('selecting an agent fires onSelect with type=agent and value=<slug>', async () => {
    const onSelect = vi.fn();
    const qc = makeQC();
    stubFetch({
      '/documents?type=agent': makeAgentsResponse(defaultAgents),
      '/members': makeMembersResponse(defaultMembers),
    });

    render(
      <MentionPicker
        workspaceSlug="acme"
        projectId="pid-1"
        query=""
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    await screen.findByText(/Reply Drafter/);

    const listbox = screen.getByRole('listbox');
    // Index 0 is already selected (first agent = 'drafter')
    fireEvent.keyDown(listbox, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith({ type: 'agent', value: 'drafter' });
  });

  it('selecting a member fires onSelect with type=user and value=<email-localpart>', async () => {
    const onSelect = vi.fn();
    const qc = makeQC();
    stubFetch({
      '/documents?type=agent': makeAgentsResponse(defaultAgents),
      '/members': makeMembersResponse(defaultMembers),
    });

    render(
      <MentionPicker
        workspaceSlug="acme"
        projectId="pid-1"
        query=""
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    await screen.findByText(/Jan Doe/);

    const listbox = screen.getByRole('listbox');

    // 2 agents → index 2 is the first member (jan@example.com)
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledWith({ type: 'user', value: 'jan' });
  });

  it('empty filtered lists show the placeholders', async () => {
    const qc = makeQC();
    stubFetch({
      '/documents?type=agent': makeAgentsResponse(defaultAgents),
      '/members': makeMembersResponse(defaultMembers),
    });

    render(
      <MentionPicker
        workspaceSlug="acme"
        projectId="pid-1"
        query="zzz"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    expect(await screen.findByText('No matching agents')).toBeInTheDocument();
    expect(await screen.findByText('No matching members')).toBeInTheDocument();
  });

  it('empty agents workspace shows "No agents yet"', async () => {
    const qc = makeQC();
    stubFetch({
      '/documents?type=agent': makeAgentsResponse([]),
      '/members': makeMembersResponse(defaultMembers),
    });

    render(
      <MentionPicker
        workspaceSlug="acme"
        projectId="pid-1"
        query=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    expect(await screen.findByText('No agents yet')).toBeInTheDocument();
  });

  it('empty members workspace shows "No members yet"', async () => {
    const qc = makeQC();
    stubFetch({
      '/documents?type=agent': makeAgentsResponse(defaultAgents),
      '/members': makeMembersResponse([]),
    });

    render(
      <MentionPicker
        workspaceSlug="acme"
        projectId="pid-1"
        query=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    expect(await screen.findByText('No members yet')).toBeInTheDocument();
  });

  it('clicking an agent row calls onSelect with type=agent', async () => {
    const onSelect = vi.fn();
    const qc = makeQC();
    stubFetch({
      '/documents?type=agent': makeAgentsResponse(defaultAgents),
      '/members': makeMembersResponse(defaultMembers),
    });

    render(
      <MentionPicker
        workspaceSlug="acme"
        projectId="pid-1"
        query=""
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    const btn = await screen.findByRole('option', { name: /Reply Drafter/i });
    fireEvent.click(btn);

    expect(onSelect).toHaveBeenCalledWith({ type: 'agent', value: 'drafter' });
  });

  it('clicking a member row calls onSelect with type=user', async () => {
    const onSelect = vi.fn();
    const qc = makeQC();
    stubFetch({
      '/documents?type=agent': makeAgentsResponse(defaultAgents),
      '/members': makeMembersResponse(defaultMembers),
    });

    render(
      <MentionPicker
        workspaceSlug="acme"
        projectId="pid-1"
        query=""
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
      { wrapper: wrap(qc) },
    );

    const btn = await screen.findByRole('option', { name: /Jan Doe/i });
    fireEvent.click(btn);

    expect(onSelect).toHaveBeenCalledWith({ type: 'user', value: 'jan' });
  });
});
