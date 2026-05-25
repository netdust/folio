import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { TokenCreateModal } from './token-create-modal.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const SCOPES = [
  'documents:read',
  'documents:write',
  'documents:delete',
  'fields:write',
  'views:write',
  'tables:write',
] as const;

describe('TokenCreateModal', () => {
  it('renders a checkbox for every v1 scope', () => {
    const qc = new QueryClient();
    render(
      <TokenCreateModal wslug="acme" workspaceId="ws-1" open onOpenChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    for (const scope of SCOPES) {
      expect(screen.getByLabelText(scope)).toBeInTheDocument();
    }
  });

  it('disables Create until name is non-empty AND at least one scope is checked', async () => {
    const qc = new QueryClient();
    const user = userEvent.setup();
    render(
      <TokenCreateModal wslug="acme" workspaceId="ws-1" open onOpenChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    const button = screen.getByRole('button', { name: /create/i });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText(/^name$/i), 'CI');
    expect(button).toBeDisabled(); // no scope yet
    await user.click(screen.getByLabelText('documents:read'));
    expect(button).not.toBeDisabled();
  });

  it('on submit, calls POST and reveals the plaintext token with a copy button', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                id: 'tok_1',
                name: 'CI',
                token: 'folio_pat_secret_xyz',
                scopes: ['documents:read'],
              },
            }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const user = userEvent.setup();
    render(
      <TokenCreateModal wslug="acme" workspaceId="ws-1" open onOpenChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    await user.type(screen.getByLabelText(/^name$/i), 'CI');
    await user.click(screen.getByLabelText('documents:read'));
    await user.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => {
      expect(screen.getByText(/folio_pat_secret_xyz/)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    // Warning that this is the only time
    expect(screen.getByText(/only time|won't be shown again|copy it now/i)).toBeInTheDocument();
  });
});
