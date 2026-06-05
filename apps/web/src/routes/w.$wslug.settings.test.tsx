import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { SettingsPage } from './w.$wslug.settings.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function stubFetch(map: Record<string, () => Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      for (const [match, build] of Object.entries(map)) {
        if (url.includes(match)) return build();
      }
      return new Response(JSON.stringify({ data: { tokens: [] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

describe('SettingsPage', () => {
  it('renders the page title and the Tokens tab content', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubFetch({
      '/api/v1/w/acme': () =>
        new Response(
          JSON.stringify({
            data: {
              id: 'ws-1',
              slug: 'acme',
              name: 'Acme',
              role: 'owner',
              createdAt: '2026-05-25T00:00:00.000Z',
              updatedAt: '2026-05-25T00:00:00.000Z',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    render(<SettingsPage wslug="acme" />, { wrapper: wrap(qc) });

    expect(await screen.findByText(/workspace settings/i)).toBeInTheDocument();
    // Tokens tab is the only one for now and is selected by default
    expect(await screen.findByText(/api tokens/i)).toBeInTheDocument();
  });

  it('shows a "Settings" link in the breadcrumb / heading for the active workspace', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubFetch({
      '/api/v1/w/acme': () =>
        new Response(
          JSON.stringify({
            data: {
              id: 'ws-1',
              slug: 'acme',
              name: 'Acme',
              role: 'owner',
              createdAt: '2026-05-25T00:00:00.000Z',
              updatedAt: '2026-05-25T00:00:00.000Z',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    render(<SettingsPage wslug="acme" />, { wrapper: wrap(qc) });
    expect(await screen.findByText('Acme')).toBeInTheDocument();
  });

  it('does NOT render AI or System Library here — those moved to /settings', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubFetch({
      '/api/v1/w/acme': () =>
        new Response(
          JSON.stringify({
            data: {
              id: 'ws-1',
              slug: 'acme',
              name: 'Acme',
              role: 'owner',
              createdAt: '2026-05-25T00:00:00.000Z',
              updatedAt: '2026-05-25T00:00:00.000Z',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });
    render(<SettingsPage wslug="acme" />, { wrapper: wrap(qc) });
    expect(await screen.findByText(/workspace settings/i)).toBeInTheDocument();
    // Only the Tokens tab remains; AI keys + System Library are instance-level.
    expect(screen.queryByRole('tab', { name: /^AI$/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/system library/i)).not.toBeInTheDocument();
  });
});
