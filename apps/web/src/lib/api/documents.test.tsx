import { afterEach, describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useUpdateDocument, type Document, type DocumentSummary } from './documents.ts';

function wrapperOf(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('Document type', () => {
  it('DocumentSummary exposes lastTouchedAt as string | null', () => {
    // Compile-time guard: this assignment fails to typecheck if the field is
    // missing. The server's GET /:slug returns lastTouchedAt; if the type
    // doesn't expose it, downstream code falls back to `as any` casts.
    const fixture: DocumentSummary = {
      id: 'd1',
      slug: 'lead',
      type: 'work_item',
      title: 'Lead',
      status: null,
      parentId: null,
      frontmatter: {},
      createdAt: '2026-01-01',
      updatedAt: '2026-01-02',
      lastTouchedAt: '2026-01-03',
    };
    expect(fixture.lastTouchedAt).toBe('2026-01-03');

    // Null is also valid (the server returns null for freshly-created docs).
    const fresh: DocumentSummary = { ...fixture, lastTouchedAt: null };
    expect(fresh.lastTouchedAt).toBeNull();
  });

  it('Document inherits lastTouchedAt from DocumentSummary', () => {
    const fixture: Document = {
      id: 'd1',
      slug: 'lead',
      type: 'work_item',
      title: 'Lead',
      status: null,
      parentId: null,
      frontmatter: {},
      createdAt: '2026-01-01',
      updatedAt: '2026-01-02',
      lastTouchedAt: null,
      body: '',
    };
    expect(fixture.lastTouchedAt).toBeNull();
  });
});

describe('useUpdateDocument', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('invalidates the document-events query for the patched slug', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === 'PATCH') {
        return new Response(
          JSON.stringify({
            data: {
              id: 'd1',
              slug: 'fix-login',
              type: 'work_item',
              title: 'Fix login bug — updated',
              status: 'todo',
              parentId: null,
              frontmatter: {},
              body: '',
              createdAt: '2026-01-01',
              updatedAt: new Date().toISOString(),
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    const { result } = renderHook(() => useUpdateDocument('acme', 'web'), {
      wrapper: wrapperOf(qc),
    });

    await result.current.mutateAsync({
      slug: 'fix-login',
      patch: { title: 'Fix login bug — updated' },
    });

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());

    const keys = invalidateSpy.mock.calls.map(([opts]) =>
      JSON.stringify((opts as { queryKey: readonly unknown[] }).queryKey),
    );

    // ActivityPanel reads from document-events. A PATCH writes a
    // document.updated event server-side; the open panel must refresh.
    expect(
      keys.some((k) =>
        k === JSON.stringify(['document-events', 'acme', 'web', 'fix-login']),
      ),
    ).toBe(true);
  });
});
