import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { InvitationsTab } from './invitations-tab.tsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

/** Route fetch by URL to the right payload + record grant/revoke calls. */
function stubApi(calls: { url: string; method: string; body: unknown }[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      let data: unknown = {};
      if (url.includes('/instance/users')) data = { users: [{ id: 'u1', email: 'a@x', name: 'Alice', role: 'member' }] };
      else if (url.includes('/instance/invite-targets'))
        data = { workspaces: [{ id: 'w1', slug: 'acme', name: 'Acme' }], projects: [{ id: 'p1', slug: 'web', name: 'Web', workspaceId: 'w1' }] };
      else if (url.includes('/instance/access')) {
        if (method === 'GET') data = { grants: [] };
        else {
          calls.push({ url, method, body });
          data = { ok: true };
        }
      }
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

describe('InvitationsTab', () => {
  it('grants a PROJECT access with the correct projectId (not workspaceId) when a project target is picked', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    stubApi(calls);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    render(<InvitationsTab />, { wrapper: wrap(qc) });

    // Wait for the async-loaded user + target options to render before selecting.
    await screen.findByRole('option', { name: /Alice/ });
    const [userSel, targetSel] = screen.getAllByRole('combobox');
    await user.selectOptions(userSel!, 'u1');
    await user.selectOptions(targetSel!, 'p:p1');
    await user.click(screen.getByRole('button', { name: /grant access/i }));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.method).toBe('POST');
    // The kind is encoded in the target value → routed to projectId, NOT workspaceId.
    expect(calls[0]!.body).toEqual({ userId: 'u1', projectId: 'p1' });
  });

  it('grants a WORKSPACE access with workspaceId when a workspace target is picked', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    stubApi(calls);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    render(<InvitationsTab />, { wrapper: wrap(qc) });

    await screen.findByRole('option', { name: /Alice/ });
    const [userSel, targetSel] = screen.getAllByRole('combobox');
    await user.selectOptions(userSel!, 'u1');
    await user.selectOptions(targetSel!, 'w:w1');
    await user.click(screen.getByRole('button', { name: /grant access/i }));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.body).toEqual({ userId: 'u1', workspaceId: 'w1' });
  });
});
