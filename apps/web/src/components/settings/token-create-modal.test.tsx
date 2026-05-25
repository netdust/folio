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
  'statuses:write',
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

  it('exposes Read-only / Read + write / Full access preset buttons', () => {
    const qc = new QueryClient();
    render(
      <TokenCreateModal wslug="acme" workspaceId="ws-1" open onOpenChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    expect(screen.getByRole('button', { name: /read-only/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /read \+ write/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /full access/i })).toBeInTheDocument();
  });

  it('clicking "Read + write" checks the right subset (no delete, no tables:write)', async () => {
    const qc = new QueryClient();
    const user = userEvent.setup();
    render(
      <TokenCreateModal wslug="acme" workspaceId="ws-1" open onOpenChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    await user.click(screen.getByRole('button', { name: /read \+ write/i }));
    expect((screen.getByLabelText('documents:read') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('documents:write') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('fields:write') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('views:write') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('statuses:write') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('documents:delete') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('tables:write') as HTMLInputElement).checked).toBe(false);
  });

  it('clicking "Full access" checks every scope', async () => {
    const qc = new QueryClient();
    const user = userEvent.setup();
    render(
      <TokenCreateModal wslug="acme" workspaceId="ws-1" open onOpenChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    await user.click(screen.getByRole('button', { name: /full access/i }));
    for (const scope of SCOPES) {
      expect((screen.getByLabelText(scope) as HTMLInputElement).checked).toBe(true);
    }
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

  // Bug H (2026-05-26): "Full access" looked like just another grey preset.
  // It now reads as the dangerous option — distinct styling + a warning line
  // when every scope is selected.
  it('renders "Full access" preset with a destructive accent (data-tone="danger")', () => {
    const qc = new QueryClient();
    render(
      <TokenCreateModal wslug="acme" workspaceId="ws-1" open onOpenChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    const fullAccess = screen.getByRole('button', { name: /full access/i });
    expect(fullAccess.getAttribute('data-tone')).toBe('danger');
    // Other presets are not danger-toned.
    expect(screen.getByRole('button', { name: /^read-only$/i }).getAttribute('data-tone')).not.toBe('danger');
    expect(screen.getByRole('button', { name: /read \+ write/i }).getAttribute('data-tone')).not.toBe('danger');
  });

  it('shows a warning alert when every scope is selected (Full access state)', async () => {
    const qc = new QueryClient();
    const user = userEvent.setup();
    render(
      <TokenCreateModal wslug="acme" workspaceId="ws-1" open onOpenChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    // No warning before Full access is clicked.
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: /full access/i }));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/every scope|root-level|trusted/i);
  });

  it('hides the warning when any scope is unchecked from Full access', async () => {
    const qc = new QueryClient();
    const user = userEvent.setup();
    render(
      <TokenCreateModal wslug="acme" workspaceId="ws-1" open onOpenChange={() => {}} />,
      { wrapper: wrap(qc) },
    );
    await user.click(screen.getByRole('button', { name: /full access/i }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    // Uncheck one scope — warning should disappear because it's no longer "every scope".
    await user.click(screen.getByLabelText('tables:write'));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
