import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { TokensTab } from './tokens-tab.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function mockListResponse(tokens: unknown[]) {
  return new Response(JSON.stringify({ data: { tokens } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('TokensTab', () => {
  it('lists tokens with name, scopes, and last-used label', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockListResponse([
          {
            id: 'tok_1',
            name: 'CI',
            scopes: ['documents:read'],
            createdAt: '2026-05-25T00:00:00.000Z',
            lastUsedAt: null,
          },
          {
            id: 'tok_2',
            name: 'Triage bot',
            scopes: ['documents:read', 'documents:write'],
            createdAt: '2026-05-20T00:00:00.000Z',
            lastUsedAt: '2026-05-24T12:00:00.000Z',
          },
        ]),
      ),
    );
    render(<TokensTab wslug="acme" workspaceId="ws-1" />, { wrapper: wrap(qc) });

    expect(await screen.findByText('CI')).toBeInTheDocument();
    expect(screen.getByText('Triage bot')).toBeInTheDocument();
    // First token has never been used
    expect(screen.getByText(/never used/i)).toBeInTheDocument();
  });

  it('shows an empty state with a Create button when there are no tokens', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal('fetch', vi.fn(async () => mockListResponse([])));
    render(<TokensTab wslug="acme" workspaceId="ws-1" />, { wrapper: wrap(qc) });
    expect(await screen.findByText(/no api tokens/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create token/i })).toBeInTheDocument();
  });

  it('opens a confirm dialog on Revoke and calls DELETE when confirmed', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const deleteCalls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === 'DELETE') {
          deleteCalls.push(url);
          return new Response(JSON.stringify({ data: { ok: true } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return mockListResponse([
          {
            id: 'tok_1',
            name: 'CI',
            scopes: ['documents:read'],
            createdAt: '2026-05-25T00:00:00.000Z',
            lastUsedAt: null,
          },
        ]);
      }),
    );

    const user = userEvent.setup();
    render(<TokensTab wslug="acme" workspaceId="ws-1" />, { wrapper: wrap(qc) });
    const row = (await screen.findByText('CI')).closest('li')!;
    await user.click(within(row).getByRole('button', { name: /revoke/i }));

    // Dialog opens with the token name quoted
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/revoke "CI"/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /^revoke$/i }));

    await waitFor(() => {
      expect(deleteCalls.length).toBe(1);
    });
    expect(deleteCalls[0]).toContain('/api/v1/w/acme/tokens/ws-1/tok_1');
  });
});
