import { describe, test, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { AgentSidePanel } from './agent-side-panel.tsx';
import { agentPanelBus } from '../../lib/agent-panel-bus.ts';

beforeEach(() => { act(() => agentPanelBus.close()); });

describe('AgentSidePanel', () => {
  test('renders nothing when the bus is closed', () => {
    const { container } = render(<AgentSidePanel wslug="acme" />);
    expect(container).toBeEmptyDOMElement();
  });
  test('opens on the Activity tab when bus.open(activity) fires', () => {
    render(<AgentSidePanel wslug="acme" />);
    act(() => agentPanelBus.open('activity'));
    expect(screen.getByText('Agents')).toBeInTheDocument();
    // Activity tab active → its placeholder visible
    expect(screen.getByText(/activity/i)).toBeInTheDocument();
  });
  test('close button hides the panel', () => {
    render(<AgentSidePanel wslug="acme" />);
    act(() => agentPanelBus.open('run'));
    expect(screen.getByText('Agents')).toBeInTheDocument();
    act(() => screen.getByRole('button', { name: /close/i }).click());
    expect(screen.queryByText('Agents')).toBeNull();
  });
});
