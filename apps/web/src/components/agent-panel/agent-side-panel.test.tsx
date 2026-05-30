import { describe, test, expect, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AgentSidePanel } from './agent-side-panel.tsx';
import { agentPanelBus } from '../../lib/agent-panel-bus.ts';

// The Run tab mounts AgentRunLauncher, which reads workspace agents via
// react-query — so every render needs a QueryClientProvider.
function renderPanel(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => { act(() => agentPanelBus.close()); });

describe('AgentSidePanel', () => {
  test('renders nothing when the bus is closed', () => {
    const { container } = renderPanel(<AgentSidePanel wslug="acme" />);
    expect(container).toBeEmptyDOMElement();
  });
  test('opens on the Activity tab when bus.open(activity) fires', () => {
    renderPanel(<AgentSidePanel wslug="acme" />);
    act(() => agentPanelBus.open('activity'));
    expect(screen.getByText('Agents')).toBeInTheDocument();
    // Activity tab active → its placeholder visible
    expect(screen.getByText(/activity/i)).toBeInTheDocument();
  });
  test('close button hides the panel', () => {
    renderPanel(<AgentSidePanel wslug="acme" />);
    act(() => agentPanelBus.open('run'));
    expect(screen.getByText('Agents')).toBeInTheDocument();
    act(() => screen.getByRole('button', { name: /close/i }).click());
    expect(screen.queryByText('Agents')).toBeNull();
  });
});
