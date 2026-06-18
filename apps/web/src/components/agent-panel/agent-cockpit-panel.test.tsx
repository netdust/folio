import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The panel renders CockpitChat, which uses the conversations API. Mock it so
// the panel test doesn't need a real EventSource / server.
vi.mock('../../lib/api/conversations.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/conversations.ts')>();
  return {
    ...actual,
    useConversation: () => ({ thread: undefined, messages: [], isLoading: false }),
    useCreateConversation: () => ({ mutateAsync: vi.fn(), isPending: false }),
    usePostMessage: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useRecentConversation: () => ({ recentId: null, loaded: true }),
  };
});

// The header reads the workspace name via useWorkspace (react-query). Mock it so
// the panel test doesn't need a QueryClientProvider.
vi.mock('../../lib/api/workspaces.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/workspaces.ts')>();
  return {
    ...actual,
    useWorkspace: () => ({ data: { name: 'QA' } }),
  };
});

import { agentPanelBus } from '../../lib/agent-panel-bus.ts';
import { AgentCockpitPanel } from './agent-cockpit-panel.tsx';

describe('AgentCockpitPanel', () => {
  beforeEach(() => {
    // Start each test from a known-closed state (clears any default-open).
    agentPanelBus.close();
  });
  afterEach(() => {
    agentPanelBus.close();
  });

  it('renders null when the bus is closed', () => {
    render(<AgentCockpitPanel />);
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('opens on the Chat tab with the composer and the tab bar', async () => {
    render(<AgentCockpitPanel />);
    act(() => agentPanelBus.open());
    // Chat is the default tab: the composer textbox is present.
    expect(await screen.findByRole('textbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    // The Chat / Activity / History tab bar is present.
    expect(screen.getByRole('button', { name: /^chat$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^activity/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^history$/i })).toBeInTheDocument();
  });

  it('switches the body when the Activity tab is clicked', async () => {
    render(<AgentCockpitPanel />);
    act(() => agentPanelBus.open());
    // Chat body (composer) is visible to start.
    expect(await screen.findByRole('textbox')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^activity/i }));
    // Activity placeholder shows; the chat composer is hidden (still mounted).
    expect(screen.getByText(/no operator activity yet/i)).toBeInTheDocument();
  });

  it('closes when the Close button is clicked', async () => {
    render(<AgentCockpitPanel />);
    act(() => agentPanelBus.open());
    const closeBtn = await screen.findByRole('button', { name: 'Close' });
    fireEvent.click(closeBtn);
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });
});
