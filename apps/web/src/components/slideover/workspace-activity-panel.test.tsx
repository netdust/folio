import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkspaceActivityPanel } from './workspace-activity-panel.tsx';

function wrap(qc: QueryClient, ui: React.ReactElement) {
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

function mockEvents(events: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      if (u.endsWith('/events')) {
        return new Response(JSON.stringify({ data: events }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

describe('WorkspaceActivityPanel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('hits /w/:wslug/documents/:slug/events (workspace-scoped — no /p/)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(wrap(qc, <WorkspaceActivityPanel wslug="acme" slug="triage" />));

    await waitFor(() => {
      const calls = fetchMock.mock.calls.map(([url]) => String(url));
      expect(calls.some((c) => c.endsWith('/w/acme/documents/triage/events'))).toBe(true);
    });
    const calls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(calls.some((c) => c.includes('/p/'))).toBe(false);
  });

  it('renders "No activity yet." when the list is empty', async () => {
    mockEvents([]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(wrap(qc, <WorkspaceActivityPanel wslug="acme" slug="triage" />));
    await waitFor(() => expect(screen.getByText('No activity yet.')).toBeInTheDocument());
  });

  it('renders event rows with a count badge when events exist', async () => {
    mockEvents([
      { id: 'e1', kind: 'activity.logged', actor: 'u', payload: { note: 'cron ran' }, createdAt: new Date().toISOString() },
      { id: 'e2', kind: 'document.created', actor: 'u', payload: null, createdAt: new Date().toISOString() },
    ]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(wrap(qc, <WorkspaceActivityPanel wslug="acme" slug="triage" />));
    await waitFor(() => expect(screen.getByText('(2)')).toBeInTheDocument());
    expect(screen.getByText('Logged')).toBeInTheDocument();
    expect(screen.getByText('Created')).toBeInTheDocument();
    expect(screen.getByText('cron ran')).toBeInTheDocument();
  });

  it('clicking an event row toggles the raw JSON drawer', async () => {
    mockEvents([
      { id: 'e1', kind: 'activity.logged', actor: 'u', payload: { note: 'hello' }, createdAt: new Date().toISOString() },
    ]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(wrap(qc, <WorkspaceActivityPanel wslug="acme" slug="triage" />));
    await waitFor(() => expect(screen.getByText('Logged')).toBeInTheDocument());

    // Initially the raw payload <pre> is hidden — the inline 'note' span shows
    // its value, but the JSON drawer isn't open.
    expect(document.querySelector('pre')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /Logged/ }));
    await waitFor(() => expect(document.querySelector('pre')).not.toBeNull());
  });

  it('clicking the Activity header collapses the body', async () => {
    mockEvents([
      { id: 'e1', kind: 'activity.logged', actor: 'u', payload: { note: 'x' }, createdAt: new Date().toISOString() },
    ]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(wrap(qc, <WorkspaceActivityPanel wslug="acme" slug="triage" />));
    await waitFor(() => expect(screen.getByText('Logged')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /Activity/ }));
    await waitFor(() => expect(screen.queryByText('Logged')).toBeNull());
  });
});
