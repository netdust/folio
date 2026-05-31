import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const navigateMock = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

import { ActivityFeedScreen } from './activity-feed-screen.tsx';

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
  emit(t: string, data: string) {
    for (const fn of this.listeners.get(t) ?? []) fn({ data } as MessageEvent);
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  navigateMock.mockReset();
  vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
});
afterEach(() => vi.unstubAllGlobals());

describe('ActivityFeedScreen', () => {
  test('shows empty state with no events', () => {
    render(<ActivityFeedScreen wslug="acme" />);
    expect(screen.getByText(/no recent agent activity/i)).toBeInTheDocument();
  });

  test('renders a feed row with agent name and status on an event', () => {
    render(<ActivityFeedScreen wslug="acme" />);
    const es = MockEventSource.instances[0]!;
    act(() =>
      es.emit(
        'agent.run.running',
        JSON.stringify({ id: 'e1', kind: 'agent.run.running', documentId: 'run-1', payload: { agent: 'bot', to: 'running', fired_by: 'assignment' } }),
      ),
    );
    expect(screen.getByText('bot')).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
  });

  test('clicking a row navigates to the agent slideover Runs tab', async () => {
    const user = userEvent.setup();
    render(<ActivityFeedScreen wslug="acme" />);
    const es = MockEventSource.instances[0]!;
    act(() =>
      es.emit(
        'agent.run.running',
        JSON.stringify({ id: 'e1', kind: 'agent.run.running', documentId: 'run-1', payload: { agent: 'bot', to: 'running' } }),
      ),
    );
    await user.click(screen.getByText('bot'));
    // New nav stays on the current route (`to: '.'`) and merges `?doc=`/`?tab=`
    // so the layout-mounted slideover opens on the agent's Runs tab.
    expect(navigateMock).toHaveBeenCalledWith({
      to: '.',
      search: expect.any(Function),
    });
    const { search } = navigateMock.mock.calls[0]![0] as {
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(search({ existing: 'kept' })).toEqual({ existing: 'kept', doc: 'bot', tab: 'runs' });
  });
});
