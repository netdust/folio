import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useUpdateView } from './views.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useUpdateView', () => {
  it('PATCHes /views/:id and returns the unwrapped View', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({
        data: { view: { id: 'v1', name: 'Renamed', type: 'list', filters: {}, sort: [], groupBy: null, visibleFields: ['title'], columnOrder: null, isDefault: true, order: 0 } },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));

    const { result } = renderHook(() => useUpdateView('acme', 'sales'), { wrapper: wrap(qc) });
    const updated = await result.current.mutateAsync({ id: 'v1', patch: { name: 'Renamed' } });

    expect(updated.name).toBe('Renamed');
    expect(updated.id).toBe('v1');
    // Crucially: the resolved value is a View, NOT { view: View }.
    expect('view' in (updated as unknown as Record<string, unknown>)).toBe(false);
  });
});
