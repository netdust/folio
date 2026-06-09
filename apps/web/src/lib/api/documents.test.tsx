import { afterEach, describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  documentsKeys,
  sortByBoardPosition,
  useDeleteDocument,
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

describe('documentsKeys table scoping', () => {
  it('documentsKeys.list namespaces by tslug so two tables do not share a cache entry', () => {
    const a = documentsKeys.list('w', 'p', 'work-items', { type: 'work_item' });
    const b = documentsKeys.list('w', 'p', 'bugs', { type: 'work_item' });
    expect(a).not.toEqual(b);
    expect(a).toContain('work-items');
    expect(b).toContain('bugs');
  });

  it('keys identical-param lists under different tables apart while keeping params as a distinct dimension', () => {
    // tslug must be its OWN positional dimension, not conflated with params.
    // Two tables with byte-identical params must not collide, AND the params
    // object must still ride in the key (so different filters under one table
    // stay separate). The legacy 3-arg factory (wslug, pslug, params) cannot
    // satisfy both: passing tslug as the 3rd arg eats the params slot.
    const wi = documentsKeys.list('w', 'p', 'work-items', { type: 'work_item', status: ['todo'] });
    const bugs = documentsKeys.list('w', 'p', 'bugs', { type: 'work_item', status: ['todo'] });
    expect(wi).not.toEqual(bugs);
    // params survives as a real object entry in the key (last element).
    expect(wi[wi.length - 1]).toEqual({ type: 'work_item', status: ['todo'] });
    // the slug occupies a dedicated slot BEFORE the 'list' literal + params.
    expect(wi).toEqual(['documents', 'w', 'p', 'work-items', 'list', { type: 'work_item', status: ['todo'] }]);
  });
});

describe('documentsKeys table-agnostic invalidation prefix', () => {
  // A read key is [...all, w, p, tslug, 'list', params]. Sibling invalidation
  // sites (SSE live-update, activity-log, project-delete cascade) do NOT know
  // which table a changed document belongs to, so they must invalidate ACROSS
  // ALL TABLES of the project. The only prefix that prefix-matches every
  // table's list key is [...all, w, p] (drop BOTH 'list' AND tslug). TanStack
  // invalidateQueries does prefix matching: a query key matches iff the
  // invalidation key is a prefix of it.
  function isPrefixOf(prefix: readonly unknown[], key: readonly unknown[]): boolean {
    return prefix.length <= key.length && prefix.every((x, i) => x === key[i]);
  }

  it('the project-wide prefix [...all, w, p] prefix-matches EVERY table list key', () => {
    const projectPrefix = [...documentsKeys.all, 'acme', 'web'];
    const bugsKey = documentsKeys.list('acme', 'web', 'bugs', {});
    const workItemsKey = documentsKeys.list('acme', 'web', 'work-items', {});

    // A single project-wide invalidation must hit BOTH tables.
    expect(isPrefixOf(projectPrefix, bugsKey)).toBe(true);
    expect(isPrefixOf(projectPrefix, workItemsKey)).toBe(true);
  });

  it('exposes a listPrefix factory the list key derives from (so they cannot drift)', () => {
    // listPrefix must be exactly the list key WITHOUT the trailing params.
    const prefix = documentsKeys.listPrefix('acme', 'web', 'bugs');
    const key = documentsKeys.list('acme', 'web', 'bugs', { type: 'work_item' });
    expect(key.slice(0, prefix.length)).toEqual([...prefix]);
    expect(prefix).toEqual([...documentsKeys.all, 'acme', 'web', 'bugs', 'list']);
  });

  it('the LEGACY project-scoped prefix [...all, w, p, "list"] does NOT match a table-scoped key (the regression)', () => {
    // This is the bug Cluster 1 introduced: inserting tslug at index 3 pushed
    // 'list' to index 4, so the old prefix's index-3 'list' !== tslug. If a
    // sibling reverts to this stale prefix, the live list never refetches.
    const stalePrefix = [...documentsKeys.all, 'acme', 'web', 'list'];
    const bugsKey = documentsKeys.list('acme', 'web', 'bugs', {});
    const workItemsKey = documentsKeys.list('acme', 'web', 'work-items', {});
    expect(isPrefixOf(stalePrefix, bugsKey)).toBe(false);
    expect(isPrefixOf(stalePrefix, workItemsKey)).toBe(false);
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

    const { result } = renderHook(() => useUpdateDocument('acme', 'web', 'work-items'), {
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

describe('useDeleteDocument table scoping', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('invalidates a TABLE-scoped list key (the deleted doc\'s table), not the project-wide prefix', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(null, { status: 204 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    // A delete in the 'bugs' table must refresh the 'bugs' list — not the
    // default 'work-items' list. The legacy project-scoped prefix
    // [...all, wslug, pslug, 'list'] no longer prefix-matches the table-scoped
    // list key [...all, wslug, pslug, tslug, 'list', params], so the list never
    // refetches after a delete in a non-default table.
    const { result } = renderHook(() => useDeleteDocument('acme', 'web', 'bugs'), {
      wrapper: wrapperOf(qc),
    });

    await result.current.mutateAsync('squash-me');

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());

    const prefixes = invalidateSpy.mock.calls.map(([opts]) =>
      (opts as { queryKey: readonly unknown[] }).queryKey,
    );

    // The invalidation prefix must be table-scoped: [...all, wslug, pslug, tslug, 'list'].
    const bugsPrefix = JSON.stringify([...documentsKeys.all, 'acme', 'web', 'bugs', 'list']);
    const workItemsPrefix = JSON.stringify([...documentsKeys.all, 'acme', 'web', 'work-items', 'list']);
    const seen = prefixes.map((p) => JSON.stringify(p));

    expect(seen).toContain(bugsPrefix);
    // And it must NOT invalidate the wrong table's list, nor the legacy
    // project-scoped prefix that omits tslug entirely.
    expect(seen).not.toContain(workItemsPrefix);
    expect(seen).not.toContain(JSON.stringify([...documentsKeys.all, 'acme', 'web', 'list']));
  });

  it('issues the DELETE against the TABLE-scoped document route', async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      urls.push(String(url));
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    const { result } = renderHook(() => useDeleteDocument('acme', 'web', 'bugs'), {
      wrapper: wrapperOf(qc),
    });

    await result.current.mutateAsync('squash-me');

    // The URL must carry the /t/<tslug>/ segment, or the delete hits the
    // default (work-items) table and either 404s or deletes the wrong row.
    expect(urls.some((u) => u.includes('/p/web/t/bugs/documents/squash-me'))).toBe(true);
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
    const listKey = documentsKeys.list('acme', 'web', 'work-items', listParams);
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    // Seed: card-b (rank 'm') after card-a (rank 'a').
    qc.setQueryData<DocumentListPage>(listKey, {
      data: [doc({ id: 'a', slug: 'card-a', boardPosition: 'a' }), doc({ id: 'b', slug: 'card-b', boardPosition: 'm' })],
      nextCursor: null,
    });

    const { result } = renderHook(() => useUpdateDocument('acme', 'web', 'work-items', listParams), {
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
    const listKey = documentsKeys.list('acme', 'web', 'work-items', listParams);
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    qc.setQueryData<DocumentListPage>(listKey, {
      data: [doc({ id: 'a', slug: 'card-a', boardPosition: 'z' }), doc({ id: 'b', slug: 'card-b', boardPosition: 'a' })],
      nextCursor: null,
    });

    const { result } = renderHook(() => useUpdateDocument('acme', 'web', 'work-items', listParams), {
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
    const listKey = documentsKeys.list('acme', 'web', 'work-items', listParams);
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    qc.setQueryData<DocumentListPage>(listKey, {
      data: [doc({ id: 'a', slug: 'card-a', boardPosition: 'z' }), doc({ id: 'b', slug: 'card-b', boardPosition: 'a' })],
      nextCursor: null,
    });

    const { result } = renderHook(() => useUpdateDocument('acme', 'web', 'work-items', listParams), {
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
