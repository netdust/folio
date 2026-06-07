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

  it('shows "Never expires" for a null expiresAt and a date for a non-null one', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        mockListResponse([
          {
            id: 'tok_1',
            name: 'Forever',
            scopes: ['documents:read'],
            createdAt: '2026-05-25T00:00:00.000Z',
            lastUsedAt: null,
            expiresAt: null,
          },
          {
            id: 'tok_2',
            name: 'Temp',
            scopes: ['documents:read'],
            createdAt: '2026-05-25T00:00:00.000Z',
            lastUsedAt: null,
            expiresAt: '2027-01-01T00:00:00.000Z',
          },
        ]),
      ),
    );
    render(<TokensTab wslug="acme" workspaceId="ws-1" />, { wrapper: wrap(qc) });

    const foreverRow = (await screen.findByText('Forever')).closest('li')!;
    expect(within(foreverRow).getByText(/never expires/i)).toBeInTheDocument();

    const tempRow = (await screen.findByText('Temp')).closest('li')!;
    // Date is locale-formatted; assert the prefix + the year are present.
    expect(within(tempRow).getByText(/expires/i).textContent).toMatch(/2027/);
  });

  it('Rotate fires DELETE then POST (revoke old, mint new) in order', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'DELETE') {
          calls.push('DELETE');
          return new Response(JSON.stringify({ data: { ok: true } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (method === 'POST') {
          calls.push('POST');
          return new Response(
            JSON.stringify({
              data: {
                id: 'tok_new',
                name: 'CI',
                token: 'folio_pat_rotated',
                scopes: ['documents:read'],
              },
            }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          );
        }
        return mockListResponse([
          {
            id: 'tok_1',
            name: 'CI',
            scopes: ['documents:read'],
            createdAt: '2026-05-25T00:00:00.000Z',
            lastUsedAt: null,
            expiresAt: null,
          },
        ]);
      }),
    );

    const user = userEvent.setup();
    render(<TokensTab wslug="acme" workspaceId="ws-1" />, { wrapper: wrap(qc) });
    const row = (await screen.findByText('CI')).closest('li')!;
    await user.click(within(row).getByRole('button', { name: /rotate/i }));

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^rotate$/i }));

    // New secret revealed once.
    await waitFor(() => expect(screen.getByText('folio_pat_rotated')).toBeInTheDocument());
    // Delete-then-create, in that order.
    expect(calls).toEqual(['DELETE', 'POST']);
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
