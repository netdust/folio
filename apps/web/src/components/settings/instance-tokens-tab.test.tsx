import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { InstanceTokensTab } from './instance-tokens-tab.tsx';

afterEach(() => vi.unstubAllGlobals());

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function listResponse(tokens: unknown[]) {
  return new Response(JSON.stringify({ data: { tokens } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('InstanceTokensTab', () => {
  it('shows the empty state when there are no instance tokens', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal('fetch', vi.fn(async () => listResponse([])));
    render(<InstanceTokensTab />, { wrapper: wrap(qc) });
    await waitFor(() =>
      expect(screen.getByText(/no instance tokens yet/i)).toBeInTheDocument(),
    );
  });

  it('lists instance tokens with name + scopes', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        listResponse([
          {
            id: 'tok_1',
            name: 'operator',
            scopes: ['workspace:admin', 'documents:read'],
            createdAt: '2026-05-25T00:00:00.000Z',
            lastUsedAt: null,
          },
        ]),
      ),
    );
    render(<InstanceTokensTab />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('operator')).toBeInTheDocument());
    expect(screen.getByText('workspace:admin')).toBeInTheDocument();
  });

  it('creates an instance token via POST /api/v1/instance/tokens (no workspace in the URL)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            data: { id: 'tok_new', name: 'ci', token: 'folio_pat_secret', scopes: ['documents:read'] },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      return listResponse([]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<InstanceTokensTab />, { wrapper: wrap(qc) });

    await waitFor(() => expect(screen.getByText(/no instance tokens yet/i)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /create token/i }));
    await user.type(screen.getByLabelText(/^name$/i), 'ci');
    await user.click(screen.getByLabelText('documents:read'));
    await user.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'POST');
      expect(postCall).toBeDefined();
      expect(postCall![0]).toBe('/api/v1/instance/tokens'); // instance URL, no /w/:wslug
    });
    // Plaintext token revealed exactly once.
    await waitFor(() => expect(screen.getByText('folio_pat_secret')).toBeInTheDocument());
  });
});
