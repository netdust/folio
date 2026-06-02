import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useIsSystemMember } from './auth.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function stubMe(is_system_member: boolean) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(
        JSON.stringify({ data: { user: { id: 'u1', email: 'a@b', name: 'A' }, is_system_member } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ),
  );
}

describe('useIsSystemMember', () => {
  it('returns true when /auth/me reports is_system_member: true', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubMe(true);
    const { result } = renderHook(() => useIsSystemMember(), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('returns false when /auth/me reports is_system_member: false', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubMe(false);
    const { result } = renderHook(() => useIsSystemMember(), { wrapper: wrap(qc) });
    // settle the query, then assert the mapped flag
    await waitFor(() => expect(qc.getQueryData(['auth', 'me'])).toBeDefined());
    expect(result.current).toBe(false);
  });

  it('returns false while /me is loading/absent (missing flag reads false)', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // never resolve — the hook must default to false, not crash on undefined data
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const { result } = renderHook(() => useIsSystemMember(), { wrapper: wrap(qc) });
    expect(result.current).toBe(false);
  });
});
