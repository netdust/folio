import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkspaceLogActivityButton } from './workspace-log-activity-button.tsx';

function wrap(qc: QueryClient, ui: React.ReactElement) {
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe('WorkspaceLogActivityButton', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders an aria-labelled button', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(wrap(qc, <WorkspaceLogActivityButton wslug="acme" slug="triage" />));
    expect(screen.getByRole('button', { name: /Log activity/ })).toBeInTheDocument();
  });

  it('submits a workspace-scoped POST (no /p/ in URL) and closes the popover', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === 'POST') {
        return new Response(
          JSON.stringify({ data: { lastTouchedAt: new Date().toISOString() } }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(wrap(qc, <WorkspaceLogActivityButton wslug="acme" slug="triage" />));

    // Open the popover.
    await userEvent.click(screen.getByRole('button', { name: /Log activity/ }));
    const textarea = await screen.findByPlaceholderText(/What happened/);
    await userEvent.type(textarea, 'cron picked up 3 leads');
    await userEvent.click(screen.getByRole('button', { name: /^Log$/ }));

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter(([_u, init]) => init?.method === 'POST');
      expect(postCalls).toHaveLength(1);
      expect(String(postCalls[0][0])).toMatch(/\/w\/acme\/documents\/triage\/activity$/);
      expect(String(postCalls[0][0])).not.toMatch(/\/p\//);
    });
  });

  it('Cmd+Enter submits while the popover is open', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === 'POST') {
        return new Response(
          JSON.stringify({ data: { lastTouchedAt: new Date().toISOString() } }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(wrap(qc, <WorkspaceLogActivityButton wslug="acme" slug="triage" />));
    await userEvent.click(screen.getByRole('button', { name: /Log activity/ }));
    const textarea = await screen.findByPlaceholderText(/What happened/);
    await userEvent.type(textarea, 'noted');
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter(([_u, init]) => init?.method === 'POST');
      expect(postCalls).toHaveLength(1);
    });
  });

  it('does not submit when the note is empty', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(wrap(qc, <WorkspaceLogActivityButton wslug="acme" slug="triage" />));
    await userEvent.click(screen.getByRole('button', { name: /Log activity/ }));

    const logBtn = await screen.findByRole('button', { name: /^Log$/ });
    expect(logBtn).toBeDisabled();
    await userEvent.click(logBtn);

    const postCalls = fetchMock.mock.calls.filter(([_u, init]) => init?.method === 'POST');
    expect(postCalls).toHaveLength(0);
  });
});
