import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useInstanceUsers, useInviteTargets, useSetUserRole } from './instance-users.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function stubFetch(calls: { url: string; method: string; body: unknown }[], data: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

describe('useInstanceUsers', () => {
  it('GETs /api/v1/instance/users and unwraps the roster', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls: { url: string; method: string; body: unknown }[] = [];
    stubFetch(calls, { users: [{ id: 'u1', email: 'a@x', name: 'A', role: 'owner' }] });
    const { result } = renderHook(() => useInstanceUsers(), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls[0]!.url).toContain('/api/v1/instance/users');
    expect(result.current.data).toEqual([{ id: 'u1', email: 'a@x', name: 'A', role: 'owner' }]);
  });

  it('is disabled when enabled:false (non-admin must not fetch)', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useInstanceUsers({ enabled: false }), { wrapper: wrap(qc) });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('useInviteTargets', () => {
  it('GETs /api/v1/instance/invite-targets', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls: { url: string; method: string; body: unknown }[] = [];
    stubFetch(calls, { workspaces: [], projects: [] });
    const { result } = renderHook(() => useInviteTargets(), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calls[0]!.url).toContain('/api/v1/instance/invite-targets');
  });
});

describe('useSetUserRole', () => {
  it('PATCHes /api/v1/instance/users/:id/role with the new role', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls: { url: string; method: string; body: unknown }[] = [];
    stubFetch(calls, { id: 'u2', role: 'admin' });
    const { result } = renderHook(() => useSetUserRole(), { wrapper: wrap(qc) });
    await result.current.mutateAsync({ userId: 'u2', role: 'admin' });
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url).toContain('/api/v1/instance/users/u2/role');
    expect(calls[0]!.body).toEqual({ role: 'admin' });
  });
});
