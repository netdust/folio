import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('./workspace-agents-tab.tsx', () => ({ WorkspaceAgentsTab: () => <div>AGENTS TAB</div> }));
vi.mock('./workspace-triggers-page.tsx', () => ({ WorkspaceTriggersPage: () => <div>TRIGGERS TAB</div> }));
vi.mock('../settings/tokens-tab.tsx', () => ({ TokensTab: () => <div>API TAB</div> }));
vi.mock('../../lib/api/workspaces.ts', () => ({
  useWorkspace: () => ({ data: { id: 'ws-1', slug: 'netdust', name: 'Netdust' } }),
}));

import { WorkspaceAutomationPage } from './workspace-automation-page.tsx';

test('defaults to the Agents tab; switching shows Triggers', () => {
  render(<WorkspaceAutomationPage wslug="netdust" tab="agents" onTabChange={() => {}} />);
  expect(screen.getByText('AGENTS TAB')).toBeInTheDocument();
  expect(screen.queryByText('TRIGGERS TAB')).not.toBeInTheDocument();
  expect(screen.queryByText('API TAB')).not.toBeInTheDocument();
});

test('renders the Triggers tab when tab=triggers', () => {
  render(<WorkspaceAutomationPage wslug="netdust" tab="triggers" onTabChange={() => {}} />);
  expect(screen.getByText('TRIGGERS TAB')).toBeInTheDocument();
});

test('renders the API (tokens) tab when tab=api', () => {
  render(<WorkspaceAutomationPage wslug="netdust" tab="api" onTabChange={() => {}} />);
  expect(screen.getByText('API TAB')).toBeInTheDocument();
  expect(screen.queryByText('AGENTS TAB')).not.toBeInTheDocument();
});

test('clicking a tab calls onTabChange', async () => {
  const onTabChange = vi.fn();
  render(<WorkspaceAutomationPage wslug="netdust" tab="agents" onTabChange={onTabChange} />);
  await userEvent.click(screen.getByRole('button', { name: /^triggers$/i }));
  expect(onTabChange).toHaveBeenCalledWith('triggers');
  await userEvent.click(screen.getByRole('button', { name: /^api$/i }));
  expect(onTabChange).toHaveBeenCalledWith('api');
});
