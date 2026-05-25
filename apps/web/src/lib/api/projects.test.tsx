import { afterEach, describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useDeleteProject } from './projects.ts';

function wrapperOf(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useDeleteProject', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('cascade-invalidates tables, views, and documents queries for the deleted project', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useDeleteProject('acme'), { wrapper: wrapperOf(qc) });
    await result.current.mutateAsync('sales');

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());

    const keys = invalidateSpy.mock.calls.map(([opts]) =>
      JSON.stringify((opts as { queryKey: readonly unknown[] }).queryKey),
    );

    // Projects list — must invalidate.
    expect(keys.some((k) => k === JSON.stringify(['projects', 'acme', 'list']))).toBe(true);

    // Per-project caches that go stale when the project is gone.
    expect(keys.some((k) => k === JSON.stringify(['tables', 'acme', 'sales']))).toBe(true);
    expect(keys.some((k) => k === JSON.stringify(['views', 'acme', 'sales']))).toBe(true);
    expect(
      keys.some((k) => k === JSON.stringify(['documents', 'acme', 'sales', 'list'])),
    ).toBe(true);
  });
});
