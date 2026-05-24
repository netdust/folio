import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactNode } from 'react';
import { ApiError } from './client.ts';
import { useOptimisticPatch } from './optimistic.ts';

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

interface Doc { slug: string; title: string; }
type PatchVars = { slug: string; patch: Partial<Doc> };

describe('useOptimisticPatch', () => {
  let qc: QueryClient;
  const detail = (slug: string) => ['doc', slug];
  const list = ['docs'];

  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(detail('a'), { slug: 'a', title: 'old' });
    qc.setQueryData(list, [{ slug: 'a', title: 'old' }, { slug: 'b', title: 'b' }]);
  });

  it('applies optimistic patch on mutate; rolls back on error', async () => {
    const { result } = renderHook(
      () =>
        useOptimisticPatch<Doc, PatchVars>({
          detailKey: ({ slug }) => detail(slug),
          listKey: list,
          mutationFn: async () => {
            throw new ApiError(500, null);
          },
          applyToDetail: (prev, { patch }) => ({ ...prev, ...patch }),
          applyToList: (prev, { slug, patch }) =>
            prev.map((d) => (d.slug === slug ? { ...d, ...patch } : d)),
        }),
      { wrapper: wrap(qc) },
    );

    await act(async () => {
      try { await result.current.mutateAsync({ slug: 'a', patch: { title: 'new' } }); } catch {}
    });

    expect(qc.getQueryData(detail('a'))).toEqual({ slug: 'a', title: 'old' });
    const listVal = qc.getQueryData<Doc[]>(list)!;
    expect(listVal.find((d) => d.slug === 'a')?.title).toBe('old');
  });

  it('keeps optimistic state on success and invalidates', async () => {
    const { result } = renderHook(
      () =>
        useOptimisticPatch<Doc, PatchVars>({
          detailKey: ({ slug }) => detail(slug),
          listKey: list,
          mutationFn: async ({ slug, patch }) => ({ slug, title: patch.title ?? 'old' }),
          applyToDetail: (prev, { patch }) => ({ ...prev, ...patch }),
          applyToList: (prev, { slug, patch }) =>
            prev.map((d) => (d.slug === slug ? { ...d, ...patch } : d)),
        }),
      { wrapper: wrap(qc) },
    );

    await act(async () => {
      await result.current.mutateAsync({ slug: 'a', patch: { title: 'new' } });
    });

    await waitFor(() => {
      expect(qc.getQueryData<Doc>(detail('a'))?.title).toBe('new');
    });
  });
});
