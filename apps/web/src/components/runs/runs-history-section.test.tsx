import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { RunsHistorySection } from './runs-history-section.tsx';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function runDoc(id: string, title: string, createdAt: string) {
  return { id, slug: id, type: 'agent_run', status: 'completed', frontmatter: { agent_slug: 'bot', fired_by: title }, createdAt, updatedAt: createdAt, parentId: 'p1', lastTouchedAt: null };
}

beforeEach(() => {
  vi.stubGlobal('EventSource', class { addEventListener() {} removeEventListener() {} close() {} } as unknown as typeof EventSource);
});
afterEach(() => vi.unstubAllGlobals());

function fetchCalls(): string[] {
  return (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.includes('/runs'));
}

describe('RunsHistorySection', () => {
  test('queries EVERY concrete project the agent is scoped to and renders all their runs', async () => {
    // marketing → an older run; sales → a newer run. Each project returns a
    // DIFFERENT run, so both endpoints must be fetched for both to appear.
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      const data = url.includes('/p/marketing/runs')
        ? [runDoc('r-mkt', 'marketing-run', '2026-05-29T10:00:00.000Z')]
        : url.includes('/p/sales/runs')
          ? [runDoc('r-sales', 'sales-run', '2026-05-30T10:00:00.000Z')]
          : [];
      return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    wrap(<RunsHistorySection wslug="acme" agentSlug="bot" projects={['marketing', 'sales']} />);

    // `fired_by` renders as "· <title>" in the row metadata line.
    await waitFor(() => expect(screen.getByText(/marketing-run/)).toBeInTheDocument());
    expect(screen.getByText(/sales-run/)).toBeInTheDocument();

    const calls = fetchCalls();
    expect(calls.some((u) => u.includes('/p/marketing/runs'))).toBe(true);
    expect(calls.some((u) => u.includes('/p/sales/runs'))).toBe(true);
    expect(calls.every((u) => u.includes('agent=bot'))).toBe(true);

    // Merged newest-first: the sales run (2026-05-30) renders before the
    // marketing run (2026-05-29).
    const rows = screen.getAllByText(/-run$/);
    expect(rows.map((n) => n.textContent)).toEqual(['· sales-run', '· marketing-run']);
  });

  test('shows an empty state for a wildcard-only agent (no concrete project)', () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })));
    wrap(<RunsHistorySection wslug="acme" agentSlug="bot" projects={['*']} />);
    expect(screen.getByText(/no project/i)).toBeInTheDocument();
  });

  test('shows "No runs yet." only when ALL projects return zero runs', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })));
    wrap(<RunsHistorySection wslug="acme" agentSlug="bot" projects={['marketing', 'sales']} />);
    await waitFor(() => expect(screen.getByText(/no runs yet/i)).toBeInTheDocument());
  });
});
