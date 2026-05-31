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

// The agent's frontmatter.projects allow-list stores project IDs, but the
// project-scoped runs route resolves :pslug by SLUG. So the fetch mock must
// serve the workspace's projects list (id→slug) and the runs endpoints keyed
// by SLUG. `proj(id, slug)` builds a Project row.
function proj(id: string, slug: string) {
  return { id, slug, name: slug, icon: null, description: null, workspaceId: 'w1', archivedAt: null, createdAt: '', updatedAt: '' };
}

describe('RunsHistorySection', () => {
  test('resolves allow-list project IDs → slugs, then queries each project by SLUG', async () => {
    // Agent allow-list holds IDs (id-mkt, id-sales); the runs route wants slugs
    // (marketing, sales). marketing → older run; sales → newer run.
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/projects')) {
        return new Response(
          JSON.stringify({ data: [proj('id-mkt', 'marketing'), proj('id-sales', 'sales')] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      const data = url.includes('/p/marketing/runs')
        ? [runDoc('r-mkt', 'marketing-run', '2026-05-29T10:00:00.000Z')]
        : url.includes('/p/sales/runs')
          ? [runDoc('r-sales', 'sales-run', '2026-05-30T10:00:00.000Z')]
          : [];
      return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    wrap(<RunsHistorySection wslug="acme" agentSlug="bot" projects={['id-mkt', 'id-sales']} />);

    // `fired_by` renders as "· <title>" in the row metadata line.
    await waitFor(() => expect(screen.getByText(/marketing-run/)).toBeInTheDocument());
    expect(screen.getByText(/sales-run/)).toBeInTheDocument();

    const calls = fetchCalls();
    // The runs URLs use the resolved SLUGs, never the raw allow-list IDs.
    expect(calls.some((u) => u.includes('/p/marketing/runs'))).toBe(true);
    expect(calls.some((u) => u.includes('/p/sales/runs'))).toBe(true);
    expect(calls.some((u) => u.includes('/p/id-mkt/') || u.includes('/p/id-sales/'))).toBe(false);
    expect(calls.every((u) => u.includes('agent=bot'))).toBe(true);

    // Merged newest-first: sales (2026-05-30) before marketing (2026-05-29).
    const rows = screen.getAllByText(/-run$/);
    expect(rows.map((n) => n.textContent)).toEqual(['· sales-run', '· marketing-run']);
  });

  test('wildcard agent queries EVERY workspace project and renders their runs', async () => {
    // projects: ['*'] = runs everywhere. The Runs tab must enumerate all
    // workspace projects (by slug) and merge their runs — not show empty.
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/projects')) {
        return new Response(
          JSON.stringify({ data: [proj('id-mkt', 'marketing'), proj('id-sales', 'sales')] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      const data = url.includes('/p/marketing/runs')
        ? [runDoc('r-mkt', 'marketing-run', '2026-05-29T10:00:00.000Z')]
        : url.includes('/p/sales/runs')
          ? [runDoc('r-sales', 'sales-run', '2026-05-30T10:00:00.000Z')]
          : [];
      return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    wrap(<RunsHistorySection wslug="acme" agentSlug="bot" projects={['*']} />);

    await waitFor(() => expect(screen.getByText(/marketing-run/)).toBeInTheDocument());
    expect(screen.getByText(/sales-run/)).toBeInTheDocument();
    const calls = fetchCalls();
    expect(calls.some((u) => u.includes('/p/marketing/runs'))).toBe(true);
    expect(calls.some((u) => u.includes('/p/sales/runs'))).toBe(true);
  });

  test('wildcard agent in an EMPTY workspace shows a terminal "no projects" state (not a spinner)', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/projects')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    wrap(<RunsHistorySection wslug="acme" agentSlug="bot" projects={['*']} />);
    await waitFor(() => expect(screen.getByText(/no projects in this workspace/i)).toBeInTheDocument());
    expect(screen.queryByText(/loading runs/i)).toBeNull();
  });

  test('a genuinely unscoped agent (empty allow-list, no wildcard) shows "No project scoped"', () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })));
    wrap(<RunsHistorySection wslug="acme" agentSlug="bot" projects={[]} />);
    expect(screen.getByText(/no project scoped/i)).toBeInTheDocument();
  });

  test('shows "No runs yet." only when ALL projects return zero runs', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/projects')) {
        return new Response(
          JSON.stringify({ data: [proj('id-mkt', 'marketing'), proj('id-sales', 'sales')] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    wrap(<RunsHistorySection wslug="acme" agentSlug="bot" projects={['id-mkt', 'id-sales']} />);
    await waitFor(() => expect(screen.getByText(/no runs yet/i)).toBeInTheDocument());
  });

  test('stale allow-list IDs (projects deleted) show a TERMINAL state, not a perpetual "Loading runs…"', async () => {
    // The projects list resolves, but it does NOT contain the agent's allow-list
    // IDs (those projects were deleted). concreteSlugs is empty AND projects
    // finished loading → must show the deleted-project terminal copy, never spin
    // on "Loading runs…" forever.
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/projects')) {
        // Workspace has some OTHER project; the agent's IDs aren't here.
        return new Response(
          JSON.stringify({ data: [proj('id-other', 'other')] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    wrap(<RunsHistorySection wslug="acme" agentSlug="bot" projects={['id-deleted-1', 'id-deleted-2']} />);
    await waitFor(() => expect(screen.getByText(/no longer exist/i)).toBeInTheDocument());
    expect(screen.queryByText(/loading runs/i)).toBeNull();
  });
});
