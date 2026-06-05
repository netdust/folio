import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

// The panel renders CockpitChat, which uses the conversations API. Mock it so
// the panel test doesn't need a real EventSource / server.
vi.mock('../../lib/api/conversations.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/conversations.ts')>();
  return {
    ...actual,
    useConversation: () => ({ thread: undefined, messages: [], isLoading: false }),
    useCreateConversation: () => ({ mutateAsync: vi.fn(), isPending: false }),
    usePostMessage: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

import { AgentCockpitPanel } from './agent-cockpit-panel.tsx';
import { agentPanelBus } from '../../lib/agent-panel-bus.ts';

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

  it('renders the operator CHAT (composer) when open — not Activity/Run tabs', async () => {
    render(<AgentCockpitPanel />);
    act(() => agentPanelBus.open());
    // The cockpit body is the chat: a composer textbox is present.
    expect(await screen.findByRole('textbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    // No tab buttons from the deleted Activity/Run surfaces.
    expect(screen.queryByRole('button', { name: /^activity$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^run$/i })).toBeNull();
  });

  it('closes when the Close button is clicked', async () => {
    render(<AgentCockpitPanel />);
    act(() => agentPanelBus.open());
    const closeBtn = await screen.findByRole('button', { name: 'Close' });
    fireEvent.click(closeBtn);
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });
});
