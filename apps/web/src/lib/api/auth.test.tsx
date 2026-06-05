import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useIsInstanceAdmin, useIsInstanceOwner } from './auth.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function stubMe(payload: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { user: { id: 'u', email: 'e', name: 'n' }, ...payload } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
}

describe('useIsInstanceAdmin', () => {
  it('reflects /me is_instance_admin', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubMe({ is_instance_admin: true, role: 'admin' });
    const { result } = renderHook(() => useIsInstanceAdmin(), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('reads false from a partial/absent cache', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const { result } = renderHook(() => useIsInstanceAdmin(), { wrapper: wrap(qc) });
    expect(result.current).toBe(false);
  });
});

describe('useIsInstanceOwner', () => {
  it('is true only when /me role === owner', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubMe({ role: 'owner', is_instance_admin: true });
    const { result } = renderHook(() => useIsInstanceOwner(), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('is false for an admin (admin is not owner — mirrors the owner-only gate)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubMe({ role: 'admin', is_instance_admin: true });
    const { result } = renderHook(() => useIsInstanceOwner(), { wrapper: wrap(qc) });
    // settle the query then assert
    await waitFor(() => expect(qc.getQueryData(['auth', 'me'])).toBeDefined());
    expect(result.current).toBe(false);
  });
});
