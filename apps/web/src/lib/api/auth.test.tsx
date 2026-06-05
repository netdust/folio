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

describe('useIsSystemMember (deprecated — __system removed in Phase 4)', () => {
  // The __system library workspace was torn down; there are no "system members"
  // anymore. The helper is a deprecated stub that always returns false until its
  // callers are migrated off (Phase 5 / Task 23).
  it('always returns false, regardless of /me (deprecated stub)', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stubMe(true); // even if /me somehow reported a truthy flag, the stub ignores it
    const { result } = renderHook(() => useIsSystemMember(), { wrapper: wrap(qc) });
    expect(result.current).toBe(false);
  });
});
