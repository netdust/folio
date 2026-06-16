import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client.ts';

// R1 fix (post-review-of-review) — kept lockstep with the server's
// DocumentType union (apps/server/src/services/documents.ts:47). C-1
// widened the server union to include 'agent_run' but the FE was not
// updated; default GET /documents (no type filter) then leaked
// agent_run rows through to FE consumers that narrowed on the 4-member
// shape. Routes that explicitly handle agent_run rows should switch on
// `type === 'agent_run'` and either delegate to Sub-phase D's /runs
// UI or render a "Use the runs view" placeholder.
export type DocumentType = 'work_item' | 'page' | 'agent' | 'trigger' | 'agent_run';

export interface DocumentSummary {
  id: string;
  slug: string;
  type: DocumentType;
  title: string;
  status: string | null;
  boardPosition: string | null;
  parentId: string | null;
  frontmatter: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  // ISO timestamp; null until activity is first logged. Phase 1.7 column —
  // surfaces in /stale_for filters and the planned "stale dashboard" bucket.
  lastTouchedAt: string | null;
  // The list endpoint OMITS `body` by default (M4 body-less projection — the
  // table/board hot path). It is present ONLY when the caller passes
  // `include: 'body'` (the wiki view does, for card excerpts). Optional because
  // most list reads will not carry it; consumers must guard (`body ?? ''`).
  body?: string;
}

// A full single-document fetch (GET …/documents/:slug) + create/update results
// ALWAYS carry the body. `DocumentSummary.body` is optional (list rows are
// body-less unless include=body), so a detail-shaped Document narrows it to
// required — the slideovers + draft hook depend on body being present.
export type Document = DocumentSummary & { body: string };

export interface DocumentListPage {
  data: DocumentSummary[];
  nextCursor: string | null;
}

export interface DocumentListParams {
  type?: DocumentType;
  status?: string[];
  assignee?: string;
  updatedSince?: string;
  // Any column key — the server reads sort verbatim and falls back if unknown.
  sort?: string;
  dir?: 'asc' | 'desc';
  limit?: number;
  cursor?: string;
  // Opt the body column back in (server maps to ?include=body). Only the wiki
  // view sets this; table/board leave it unset so the hot path stays body-less.
  include?: 'body';
  // Generic frontmatter filter, serialized to the server's `?filter=<JSON>`
  // param (routes/documents.ts → lib/filter-to-drizzle.ts). Used for arbitrary
  // frontmatter keys (e.g. priority) that have no dedicated query param. Status,
  // assignee, updated_since keep their own params above. NOTE: labels is NOT
  // expressible here — the compiler has no array-contains operator — so it stays
  // a client-side post-filter (see applyFrontmatterClauses + the deferred note).
  filter?: Record<string, unknown>;
}

function toSearch(params: DocumentListParams): string {
  const sp = new URLSearchParams();
  if (params.type) sp.set('type', params.type);
  for (const s of params.status ?? []) sp.append('status', s);
  if (params.assignee) sp.set('assignee', params.assignee);
  if (params.updatedSince) sp.set('updated_since', params.updatedSince);
  if (params.sort) sp.set('sort', params.sort);
  if (params.dir) sp.set('dir', params.dir);
  if (params.limit) sp.set('limit', String(params.limit));
  if (params.cursor) sp.set('cursor', params.cursor);
  if (params.include) sp.set('include', params.include);
  if (params.filter && Object.keys(params.filter).length > 0) {
    sp.set('filter', JSON.stringify(params.filter));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const documentsKeys = {
  all: ['documents'] as const,
  // The list prefix (table-scoped) — in-table invalidations target THIS so they
  // always prefix-match the read key, which appends `params`. Single-sources the
  // prefix so the read key and its invalidations cannot drift apart (the bug
  // Cluster 1 introduced when tslug was inserted ahead of the 'list' literal).
  listPrefix: (wslug: string, pslug: string, tslug: string) =>
    [...documentsKeys.all, wslug, pslug, tslug, 'list'] as const,
  list: (wslug: string, pslug: string, tslug: string, params: DocumentListParams = {}) =>
    [...documentsKeys.listPrefix(wslug, pslug, tslug), params] as const,
  detail: (wslug: string, pslug: string, slug: string) =>
    [...documentsKeys.all, wslug, pslug, 'detail', slug] as const,
};

export function useDocuments(
  wslug: string,
  pslug: string,
  tslug: string,
  params: DocumentListParams = {},
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: documentsKeys.list(wslug, pslug, tslug, params),
    queryFn: () =>
      client.get<DocumentListPage>(
        `/api/v1/w/${wslug}/p/${pslug}/t/${tslug}/documents${toSearch(params)}`,
      ),
    staleTime: 30_000,
    enabled: !!wslug && !!pslug && !!tslug && (options.enabled ?? true),
  });
}

/**
 * Paginated table read — consumes the server's keyset `nextCursor` so the table
 * shows ALL matching rows across pages, not just the first page. Before M3 the
 * table used the single-page `useDocuments` and post-filtered the current page
 * client-side, so a match on page 2 was invisible. This hook + server-side
 * frontmatter filtering (params.filter) fix that.
 *
 * The `params` (incl. `filter`) is part of the query key, so a filter change is
 * a NEW infinite query that resets pagination from the first page.
 */
export function useInfiniteDocuments(
  wslug: string,
  pslug: string,
  tslug: string,
  params: DocumentListParams = {},
  options: { enabled?: boolean } = {},
) {
  return useInfiniteQuery({
    queryKey: documentsKeys.list(wslug, pslug, tslug, params),
    queryFn: ({ pageParam }) =>
      client.get<DocumentListPage>(
        `/api/v1/w/${wslug}/p/${pslug}/t/${tslug}/documents${toSearch(
          pageParam ? { ...params, cursor: pageParam } : params,
        )}`,
      ),
    initialPageParam: undefined as string | undefined,
    // null nextCursor → no further pages. `undefined` tells react-query there is
    // no next page, so hasNextPage is false and fetchNextPage is a no-op.
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 30_000,
    enabled: !!wslug && !!pslug && !!tslug && (options.enabled ?? true),
  });
}

export function useDocument(wslug: string, pslug: string, slug: string | null) {
  return useQuery({
    queryKey: slug ? documentsKeys.detail(wslug, pslug, slug) : ['documents', 'noop'],
    queryFn: () => client.get<Document>(`/api/v1/w/${wslug}/p/${pslug}/documents/${slug}`),
    staleTime: 30_000,
    enabled: !!wslug && !!pslug && !!slug,
  });
}

export function useCreateDocument(wslug: string, pslug: string, tslug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      type: DocumentType;
      title: string;
      body?: string;
      frontmatter?: Record<string, unknown>;
      parentId?: string | null;
    }) => client.post<Document>(`/api/v1/w/${wslug}/p/${pslug}/t/${tslug}/documents`, vars),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: documentsKeys.listPrefix(wslug, pslug, tslug) }),
  });
}

export type DocumentPatch = Partial<{
  title: string;
  status: string | null;
  body: string;
  frontmatter: Record<string, unknown>;
  parentId: string | null;
  boardPosition: string | null;
}>;

// Server null-sentinel for board_position sort: the server coalesces a null
// board_position to U+FFFF (max BMP codepoint) so unranked cards sort LAST in
// the same ORDER BY / keyset predicate. The optimistic re-sort must mirror that
// sentinel byte-for-byte or the optimistic order diverges from the refetch.
// Mirrors apps/server/src/services/documents.ts NULL_SENTINEL.
const BOARD_POSITION_NULL_SENTINEL = '￿';

/**
 * Sort a list of documents by board_position ascending, nulls last — matching
 * the server's `coalesce(board_position, U+FFFF)` ORDER BY. Returns a NEW array
 * (does not mutate the input). board_position values are sortable rank strings
 * produced by rankBetween, so a plain lexicographic compare is correct.
 */
export function sortByBoardPosition(rows: DocumentSummary[]): DocumentSummary[] {
  return [...rows].sort((a, b) => {
    const av = a.boardPosition ?? BOARD_POSITION_NULL_SENTINEL;
    const bv = b.boardPosition ?? BOARD_POSITION_NULL_SENTINEL;
    if (av < bv) return -1;
    if (av > bv) return 1;
    return 0;
  });
}

// Merge a frontmatter patch the same way the server does: undefined/null
// values DELETE the key (not "store null"). Optimistic UI must mirror this or
// the cleared field briefly renders as a ghost null before onSettled refetch.
function mergeFrontmatter(
  prev: Record<string, unknown>,
  patch: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!patch) return prev;
  const out: Record<string, unknown> = { ...prev };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

export function useUpdateDocument(
  wslug: string,
  pslug: string,
  tslug: string,
  listParams: DocumentListParams = {},
) {
  const qc = useQueryClient();
  const listKey = documentsKeys.list(wslug, pslug, tslug, listParams);
  return useMutation({
    mutationFn: ({ slug, patch }: { slug: string; patch: DocumentPatch }) =>
      client.patch<Document>(`/api/v1/w/${wslug}/p/${pslug}/t/${tslug}/documents/${slug}`, patch),
    onMutate: async ({ slug, patch }) => {
      const detailKey = documentsKeys.detail(wslug, pslug, slug);
      await qc.cancelQueries({ queryKey: detailKey });
      await qc.cancelQueries({ queryKey: listKey });
      const prevDetail = qc.getQueryData<Document>(detailKey);
      const prevList = qc.getQueryData<DocumentListPage>(listKey);
      if (prevDetail) {
        qc.setQueryData<Document>(detailKey, {
          ...prevDetail,
          ...patch,
          frontmatter: mergeFrontmatter(prevDetail.frontmatter, patch.frontmatter),
        });
      }
      if (prevList) {
        const patched = prevList.data.map((d) =>
          d.slug === slug
            ? {
                ...d,
                ...patch,
                frontmatter: mergeFrontmatter(d.frontmatter, patch.frontmatter),
              }
            : d,
        );
        // Bug 2 (2026-06-07): a board_position patch on a board_position-sorted
        // list must RE-SORT optimistically. Otherwise the moved card keeps its
        // old array slot until onSettled's refetch lands (~400ms), so it visibly
        // sits in the wrong place (and the dragged-card animation looks like a
        // snap-back). Re-sort ONLY when this is a board_position change on the
        // manual-sort query — list-view / field-sorted queries derive their
        // order from a DIFFERENT server key, so a status/title patch (or any
        // patch on a non-board_position list) must NOT reorder.
        const isBoardPositionReorder =
          patch.boardPosition !== undefined && listParams.sort === 'board_position';
        qc.setQueryData<DocumentListPage>(listKey, {
          ...prevList,
          data: isBoardPositionReorder ? sortByBoardPosition(patched) : patched,
        });
      }
      return { prevDetail, prevList, detailKey };
    },
    onError: (_err, _vars, ctx) => {
      if (!ctx) return;
      if (ctx.prevDetail) qc.setQueryData(ctx.detailKey, ctx.prevDetail);
      if (ctx.prevList) qc.setQueryData(listKey, ctx.prevList);
    },
    onSettled: (data, _err, { slug }) => {
      qc.invalidateQueries({ queryKey: documentsKeys.detail(wslug, pslug, slug) });
      // Invalidate every list query under this wslug/pslug/tslug — different
      // surfaces (list view, kanban, wiki tree) use different list params,
      // and a title/status patch in one view should refresh them all.
      qc.invalidateQueries({ queryKey: documentsKeys.listPrefix(wslug, pslug, tslug) });
      // Server emits a `document.updated` event on every PATCH; refresh the
      // ActivityPanel's events list so the slideover stays live. A title
      // patch may regenerate the slug — in that case ActivityPanel under the
      // new slug observes a different cache key, so invalidate both. Key
      // shape mirrors lib/api/events.ts:documentEventsKeys.list().
      qc.invalidateQueries({ queryKey: ['document-events', wslug, pslug, slug] });
      if (data?.slug && data.slug !== slug) {
        qc.invalidateQueries({ queryKey: ['document-events', wslug, pslug, data.slug] });
      }
    },
  });
}

export function useDeleteDocument(wslug: string, pslug: string, tslug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) =>
      client.delete<void>(`/api/v1/w/${wslug}/p/${pslug}/t/${tslug}/documents/${slug}`),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: documentsKeys.listPrefix(wslug, pslug, tslug) }),
  });
}

export function useDocumentMarkdown(wslug: string, pslug: string, tslug: string, slug: string) {
  return client.getRaw(`/api/v1/w/${wslug}/p/${pslug}/t/${tslug}/documents/${slug}.md`);
}

// ---------------------------------------------------------------------------
// Filter URL helpers
// ---------------------------------------------------------------------------

export type FilterClauseUrl =
  | { kind: 'status'; values: string[] }
  | { kind: 'priority'; value: string }
  | { kind: 'labels'; values: string[] }
  | { kind: 'assignee'; value: string }
  | { kind: 'updated_since'; value: string };

export function parseFilters(search: Record<string, unknown>): FilterClauseUrl[] {
  const out: FilterClauseUrl[] = [];
  const status = arr(search.status);
  if (status.length) out.push({ kind: 'status', values: status });
  const priority = str(search.priority);
  if (priority) out.push({ kind: 'priority', value: priority });
  const labels = arr(search.labels);
  if (labels.length) out.push({ kind: 'labels', values: labels });
  const assignee = str(search.assignee);
  if (assignee) out.push({ kind: 'assignee', value: assignee });
  const us = str(search.updated_since);
  if (us) out.push({ kind: 'updated_since', value: us });
  return out;
}

/**
 * Build the server `?filter=<JSON>` payload from the frontmatter clauses that
 * the filter compiler CAN express. Today that is `priority` only:
 *   priority → { priority: { $eq: <value> } }  (json_extract '$.priority' = ?)
 *
 * `labels` is deliberately EXCLUDED — the compiler's operator set
 * ($eq/$ne/$in/$nin/$gt/$gte/$lt/$lte/$exists) has no array-contains, and
 * json_extract('$.labels') returns the array as JSON text, so any server-side
 * operator would silently produce WRONG results. Labels stays a client-side
 * post-filter (see applyFrontmatterClauses) — tracked in the deferred backlog.
 *
 * Returns undefined when no server-expressible frontmatter clause is present,
 * so callers can omit `?filter=` entirely.
 */
export function clausesToFilterJson(
  clauses: FilterClauseUrl[],
): Record<string, unknown> | undefined {
  const filter: Record<string, unknown> = {};
  for (const c of clauses) {
    // Single-clause-per-kind assumption: the FilterBar is single-select per kind,
    // so the last priority clause wins. If multi-value priority filtering ever
    // ships, switch this to `{ priority: { $in: [...] } }`.
    if (c.kind === 'priority') filter.priority = { $eq: c.value };
  }
  return Object.keys(filter).length > 0 ? filter : undefined;
}

export function clausesToListParams(clauses: FilterClauseUrl[]): DocumentListParams {
  const p: DocumentListParams = { type: 'work_item', sort: 'updated_at', dir: 'desc' };
  for (const c of clauses) {
    if (c.kind === 'status') p.status = c.values;
    if (c.kind === 'updated_since') p.updatedSince = c.value;
    if (c.kind === 'assignee') p.assignee = c.value;
  }
  const filter = clausesToFilterJson(clauses);
  if (filter) p.filter = filter;
  return p;
}

/**
 * Client-side post-filter for the frontmatter clauses the SERVER cannot express.
 * Post-M3 this is `labels` ONLY: priority moved server-side (clausesToFilterJson)
 * so it filters correctly across pages. Keeping priority here would double-filter
 * and could drop valid server-returned rows, so it is intentionally NOT handled.
 *
 * DEFERRED: labels-array-contains is not expressible with the current filter
 * compiler operator set, so it remains a current-page post-filter and is
 * THEREFORE STILL WRONG ACROSS PAGES for labels specifically. Fixing it needs a
 * compiler array-contains operator (SQLite json_each EXISTS subquery). See
 * docs/deferred-e2e-backlog.md.
 */
export function applyFrontmatterClauses(
  docs: DocumentSummary[],
  clauses: FilterClauseUrl[],
): DocumentSummary[] {
  let out = docs;
  for (const c of clauses) {
    if (c.kind === 'labels') {
      // Labels: AND semantics — every selected value must be present. Today's UI is
      // single-select so AND ≡ OR; revisit when multi-label filtering ships.
      out = out.filter((d) => {
        const labels = d.frontmatter?.labels;
        if (!Array.isArray(labels)) return false;
        return c.values.every((v) => (labels as unknown[]).includes(v));
      });
    }
    // 'priority' is now sent to the server (clausesToFilterJson); 'status' /
    // 'assignee' / 'updated_since' use dedicated server params — nothing to do.
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function arr(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string' && v.length > 0) return [v];
  return [];
}
