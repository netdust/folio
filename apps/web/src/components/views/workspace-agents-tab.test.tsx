import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, test, vi, beforeEach } from 'vitest';

const navigateMock = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigateMock }));

const agentsData = [
  { id: '1', slug: 'writer', title: 'Writer', frontmatter: { provider: 'anthropic', model: 'claude-haiku-4-5', projects: ['*'] } },
];
vi.mock('../../lib/api/workspace-documents.ts', () => ({
  useWorkspaceAgents: () => ({ data: agentsData, isLoading: false }),
  useCreateWorkspaceDocument: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { WorkspaceAgentsTab } from './workspace-agents-tab.tsx';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => navigateMock.mockReset());

test('lists agents with provider·model + projects chips', () => {
  wrap(<WorkspaceAgentsTab wslug="netdust" />);
  expect(screen.getByText('Writer')).toBeInTheDocument();
  expect(screen.getByText(/anthropic·claude-haiku-4-5/)).toBeInTheDocument();
  expect(screen.getByText('All projects')).toBeInTheDocument();
});

test('clicking an agent row opens its config via ?wdoc=', async () => {
  wrap(<WorkspaceAgentsTab wslug="netdust" />);
  await userEvent.click(screen.getByText('Writer'));
  expect(navigateMock).toHaveBeenCalledWith(
    expect.objectContaining({ to: '.', search: expect.any(Function) }),
  );
});
