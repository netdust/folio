import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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

/** Mock useMe to identify the current user (drives the own-row read-only guard). */
function mockMe(userId: string) {
  vi.spyOn(auth, 'useMe').mockReturnValue({
    data: { user: { id: userId, email: 'me@x', name: 'Me' } },
  } as unknown as ReturnType<typeof auth.useMe>);
}

describe('RolesTab', () => {
  it('an OWNER sees an editable role select for OTHER users', async () => {
    vi.spyOn(auth, 'useIsInstanceOwner').mockReturnValue(true);
    mockMe('someone-else'); // current user is neither u1 nor u2 → both rows editable
    stubUsers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<RolesTab />, { wrapper: wrap(qc) });
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    // Both users are OTHER users → two role <select>s.
    expect(screen.getAllByRole('combobox')).toHaveLength(2);
  });

  it("an owner's OWN row is read-only — cannot self-demote (mirrors the server guard)", async () => {
    vi.spyOn(auth, 'useIsInstanceOwner').mockReturnValue(true);
    mockMe('u1'); // current user IS Alice (u1, an owner)
    stubUsers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<RolesTab />, { wrapper: wrap(qc) });
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    // Only Bob (u2) gets a select; Alice's own row is read-only → exactly one.
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
  });

  it('a non-owner (admin) sees roles READ-ONLY — no select, mirrors the owner-only server gate', async () => {
    vi.spyOn(auth, 'useIsInstanceOwner').mockReturnValue(false);
    mockMe('u1');
    stubUsers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<RolesTab />, { wrapper: wrap(qc) });
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByText(/only the instance owner/i)).toBeInTheDocument();
  });

  it('an OWNER sees a Remove button on other rows but NOT their own', async () => {
    vi.spyOn(auth, 'useIsInstanceOwner').mockReturnValue(true);
    mockMe('u1'); // Alice (owner) is current user
    stubUsers();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<RolesTab />, { wrapper: wrap(qc) });
    expect(await screen.findByText('Bob')).toBeInTheDocument();
    // Exactly one Remove button — Bob's. Alice's own row has none (no self-delete).
    expect(screen.getAllByRole('button', { name: /^remove$/i })).toHaveLength(1);
  });

  it('Remove → confirm fires DELETE /instance/users/:id', async () => {
    vi.spyOn(auth, 'useIsInstanceOwner').mockReturnValue(true);
    mockMe('someone-else');
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (method === 'DELETE') {
          calls.push({ url, method });
          return new Response(JSON.stringify({ data: { ok: true, id: 'u2' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            data: { users: [{ id: 'u2', email: 'b@x', name: 'Bob', role: 'member' }] },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<RolesTab />, { wrapper: wrap(qc) });

    await user.click(await screen.findByRole('button', { name: /^remove$/i }));
    // Confirm dialog → the danger "Remove" in the dialog footer.
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^remove$/i }));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.url).toContain('/api/v1/instance/users/u2');
    expect(calls[0]!.method).toBe('DELETE');
  });
});
