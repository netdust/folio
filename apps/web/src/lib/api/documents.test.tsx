import { afterEach, describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  documentsKeys,
  sortByBoardPosition,
  useUpdateDocument,
  type Document,
  type DocumentListPage,
  type DocumentSummary,
} from './documents.ts';

function wrapperOf(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function doc(overrides: Partial<DocumentSummary> = {}): DocumentSummary {
  return {
    id: 'd1',
    slug: 'card-a',
    type: 'work_item',
    title: 'Card A',
    status: 'todo',
    boardPosition: null,
    parentId: null,
    frontmatter: {},
    createdAt: '2026-01-01',
    updatedAt: '2026-01-02',
    lastTouchedAt: null,
    body: '',
    ...overrides,
  };
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

describe('sortByBoardPosition', () => {
  it('sorts non-null rank strings lexicographically ascending', () => {
    const rows = [
      doc({ id: 'c', slug: 'c', boardPosition: 'n' }),
      doc({ id: 'a', slug: 'a', boardPosition: 'a' }),
      doc({ id: 'b', slug: 'b', boardPosition: 'h' }),
    ];
    expect(sortByBoardPosition(rows).map((r) => r.slug)).toEqual(['a', 'b', 'c']);
  });

  it('sorts null board_position LAST (mirrors the server U+FFFF sentinel)', () => {
    const rows = [
      doc({ id: 'unranked', slug: 'unranked', boardPosition: null }),
      doc({ id: 'ranked', slug: 'ranked', boardPosition: 'm' }),
    ];
    expect(sortByBoardPosition(rows).map((r) => r.slug)).toEqual(['ranked', 'unranked']);
  });

  it('does not mutate the input array', () => {
    const rows = [
      doc({ id: 'b', slug: 'b', boardPosition: 'z' }),
      doc({ id: 'a', slug: 'a', boardPosition: 'a' }),
    ];
    const original = rows.map((r) => r.slug);
    sortByBoardPosition(rows);
    expect(rows.map((r) => r.slug)).toEqual(original);
  });
});

describe('useUpdateDocument optimistic re-sort', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function stubPatchFetch() {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response('{"data":{}}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
  }

  it('re-sorts a board_position-sorted list immediately on a boardPosition patch', async () => {
    stubPatchFetch();
    const listParams = { type: 'work_item' as const, sort: 'board_position', dir: 'asc' as const };
    const listKey = documentsKeys.list('acme', 'web', listParams);
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    // Seed: card-b (rank 'm') after card-a (rank 'a').
    qc.setQueryData<DocumentListPage>(listKey, {
      data: [doc({ id: 'a', slug: 'card-a', boardPosition: 'a' }), doc({ id: 'b', slug: 'card-b', boardPosition: 'm' })],
      nextCursor: null,
    });

    const { result } = renderHook(() => useUpdateDocument('acme', 'web', listParams), {
      wrapper: wrapperOf(qc),
    });

    // Move card-b BEFORE card-a (new rank sorts first).
    void result.current.mutate({ slug: 'card-b', patch: { boardPosition: '0' } });

    // The cache must reflect the new order SYNCHRONOUSLY (onMutate), before the
    // PATCH resolves or onSettled refetches. This is the "no animate-back" fix:
    // the moved card appears in its new slot immediately.
    await waitFor(() => {
      const cached = qc.getQueryData<DocumentListPage>(listKey);
      expect(cached?.data.map((d) => d.slug)).toEqual(['card-b', 'card-a']);
    });
  });

  it('does NOT reorder a non-board_position list on a status patch', async () => {
    stubPatchFetch();
    // A field-sorted (updated_at) list — order is server-derived from a
    // different key, so a status patch must leave the array order untouched.
    const listParams = { type: 'work_item' as const, sort: 'updated_at', dir: 'desc' as const };
    const listKey = documentsKeys.list('acme', 'web', listParams);
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    qc.setQueryData<DocumentListPage>(listKey, {
      data: [doc({ id: 'a', slug: 'card-a', boardPosition: 'z' }), doc({ id: 'b', slug: 'card-b', boardPosition: 'a' })],
      nextCursor: null,
    });

    const { result } = renderHook(() => useUpdateDocument('acme', 'web', listParams), {
      wrapper: wrapperOf(qc),
    });

    void result.current.mutate({ slug: 'card-a', patch: { status: 'done' } });

    await waitFor(() => {
      const cached = qc.getQueryData<DocumentListPage>(listKey);
      // Order preserved (NOT re-sorted by board_position even though the ranks
      // would imply card-b first). The status patch is applied in place.
      expect(cached?.data.map((d) => d.slug)).toEqual(['card-a', 'card-b']);
      expect(cached?.data.find((d) => d.slug === 'card-a')?.status).toBe('done');
    });
  });

  it('does NOT reorder a board_position list on a NON-boardPosition patch', async () => {
    stubPatchFetch();
    // Even on the manual-sort list, a patch that does not touch boardPosition
    // (e.g. a title edit) must not reorder — the existing order is correct.
    const listParams = { type: 'work_item' as const, sort: 'board_position', dir: 'asc' as const };
    const listKey = documentsKeys.list('acme', 'web', listParams);
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    qc.setQueryData<DocumentListPage>(listKey, {
      data: [doc({ id: 'a', slug: 'card-a', boardPosition: 'z' }), doc({ id: 'b', slug: 'card-b', boardPosition: 'a' })],
      nextCursor: null,
    });

    const { result } = renderHook(() => useUpdateDocument('acme', 'web', listParams), {
      wrapper: wrapperOf(qc),
    });

    void result.current.mutate({ slug: 'card-a', patch: { title: 'Renamed' } });

    await waitFor(() => {
      const cached = qc.getQueryData<DocumentListPage>(listKey);
      expect(cached?.data.map((d) => d.slug)).toEqual(['card-a', 'card-b']);
      expect(cached?.data.find((d) => d.slug === 'card-a')?.title).toBe('Renamed');
    });
  });
});
