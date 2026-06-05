import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { RolesTab } from './roles-tab.tsx';
import * as auth from '../../lib/api/auth.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function stubUsers() {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              users: [
                { id: 'u1', email: 'a@x', name: 'Alice', role: 'owner' },
                { id: 'u2', email: 'b@x', name: 'Bob', role: 'member' },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ),
  );
}

describe('RolesTab', () => {
  it('an OWNER sees an editable role select per user', async () => {
    vi.spyOn(auth, 'useIsInstanceOwner').mockReturnValue(true);
    stubUsers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<RolesTab />, { wrapper: wrap(qc) });
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    // Two users → two role <select>s (combobox role).
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
  });

  it('a non-owner (admin) sees roles READ-ONLY — no select, mirrors the owner-only server gate', async () => {
    vi.spyOn(auth, 'useIsInstanceOwner').mockReturnValue(false);
    stubUsers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<RolesTab />, { wrapper: wrap(qc) });
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByText(/only the instance owner/i)).toBeInTheDocument();
  });
});
