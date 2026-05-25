import { afterEach, describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLogActivity } from './events.ts';

function wrapperOf(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useLogActivity', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('invalidates only scoped document keys (not the broad ["documents"] prefix)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith('/activity') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ data: { lastTouchedAt: new Date().toISOString() } }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useLogActivity('acme', 'web'), {
      wrapper: wrapperOf(qc),
    });

    await result.current.mutateAsync({ slug: 'lead-foo', note: 'Pinged' });

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());

    const keys = invalidateSpy.mock.calls.map(([opts]) =>
      JSON.stringify((opts as { queryKey: readonly unknown[] }).queryKey),
    );

    // Broad ['documents'] prefix must NOT be used — it nukes every workspace's
    // document caches in every open tab.
    expect(keys.some((k) => k === JSON.stringify(['documents']))).toBe(false);

    // Must invalidate the events list for this doc.
    expect(keys.some((k) =>
      k === JSON.stringify(['document-events', 'acme', 'web', 'lead-foo']),
    )).toBe(true);

    // Must invalidate the scoped documents list (so the doc surfaces in
    // updated-at sort once the server bumps updatedAt).
    expect(keys.some((k) =>
      k === JSON.stringify(['documents', 'acme', 'web', 'list']),
    )).toBe(true);

    // Must invalidate the doc's detail (so lastTouchedAt is fresh in the slideover).
    expect(keys.some((k) =>
      k === JSON.stringify(['documents', 'acme', 'web', 'detail', 'lead-foo']),
    )).toBe(true);
  });
});
