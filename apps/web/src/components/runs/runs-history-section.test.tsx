import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { RunsHistorySection } from './runs-history-section.tsx';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.stubGlobal('EventSource', class { addEventListener() {} removeEventListener() {} close() {} } as unknown as typeof EventSource);
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () =>
    new Response(JSON.stringify({ data: [
      { id: 'r1', slug: 'run-1', type: 'agent_run', status: 'completed', frontmatter: { agent_slug: 'bot', fired_by: 'assignment' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), parentId: 'p1', lastTouchedAt: null },
    ] }), { status: 200, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => vi.unstubAllGlobals());

describe('RunsHistorySection', () => {
  test('renders the agent run rows for the primary (first non-wildcard) project', async () => {
    wrap(<RunsHistorySection wslug="acme" agentSlug="bot" projects={['marketing', 'sales']} />);
    await waitFor(() => expect(screen.getByText('bot')).toBeInTheDocument());
    expect(screen.getByText('completed')).toBeInTheDocument();
    const call = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.find((c) => String(c[0]).includes('/runs'));
    expect(String(call![0])).toContain('/p/marketing/runs');
    expect(String(call![0])).toContain('agent=bot');
  });

  test('shows an empty state for a wildcard-only agent (no concrete project)', () => {
    wrap(<RunsHistorySection wslug="acme" agentSlug="bot" projects={['*']} />);
    expect(screen.getByText(/no project/i)).toBeInTheDocument();
  });
});
