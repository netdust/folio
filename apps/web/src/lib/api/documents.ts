import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  parentId: string | null;
  frontmatter: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  // ISO timestamp; null until activity is first logged. Phase 1.7 column —
  // surfaces in /stale_for filters and the planned "stale dashboard" bucket.
  lastTouchedAt: string | null;
  // The list endpoint already returns `body` over the wire (server selects
  // rows un-projected); the type historically under-declared it. Widening
  // here makes node.doc.body available for card excerpts.
  body: string;
}

export type Document = DocumentSummary;

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
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const documentsKeys = {
  all: ['documents'] as const,
  list: (wslug: string, pslug: string, params: DocumentListParams = {}) =>
    [...documentsKeys.all, wslug, pslug, 'list', params] as const,
  detail: (wslug: string, pslug: string, slug: string) =>
    [...documentsKeys.all, wslug, pslug, 'detail', slug] as const,
};

export function useDocuments(
  wslug: string,
  pslug: string,
  params: DocumentListParams = {},
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: documentsKeys.list(wslug, pslug, params),
    queryFn: () =>
      client.get<DocumentListPage>(`/api/v1/w/${wslug}/p/${pslug}/documents${toSearch(params)}`),
    staleTime: 30_000,
    enabled: !!wslug && !!pslug && (options.enabled ?? true),
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

export function useCreateDocument(wslug: string, pslug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      type: DocumentType;
      title: string;
      body?: string;
      frontmatter?: Record<string, unknown>;
      parentId?: string | null;
    }) => client.post<Document>(`/api/v1/w/${wslug}/p/${pslug}/documents`, vars),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: [...documentsKeys.all, wslug, pslug, 'list'] }),
  });
}

export type DocumentPatch = Partial<{
  title: string;
  status: string | null;
  body: string;
  frontmatter: Record<string, unknown>;
  parentId: string | null;
}>;

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

export function useUpdateDocument(wslug: string, pslug: string, listParams: DocumentListParams = {}) {
  const qc = useQueryClient();
  const listKey = documentsKeys.list(wslug, pslug, listParams);
  return useMutation({
    mutationFn: ({ slug, patch }: { slug: string; patch: DocumentPatch }) =>
      client.patch<Document>(`/api/v1/w/${wslug}/p/${pslug}/documents/${slug}`, patch),
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
        qc.setQueryData<DocumentListPage>(listKey, {
          ...prevList,
          data: prevList.data.map((d) =>
            d.slug === slug
              ? {
                  ...d,
                  ...patch,
                  frontmatter: mergeFrontmatter(d.frontmatter, patch.frontmatter),
                }
              : d,
          ),
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
      // Invalidate every list query under this wslug/pslug — different
      // surfaces (list view, kanban, wiki tree) use different list params,
      // and a title/status patch in one view should refresh them all.
      qc.invalidateQueries({ queryKey: [...documentsKeys.all, wslug, pslug, 'list'] });
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

export function useDeleteDocument(wslug: string, pslug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) =>
      client.delete<void>(`/api/v1/w/${wslug}/p/${pslug}/documents/${slug}`),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: [...documentsKeys.all, wslug, pslug, 'list'] }),
  });
}

export function useDocumentMarkdown(wslug: string, pslug: string, slug: string) {
  return client.getRaw(`/api/v1/w/${wslug}/p/${pslug}/documents/${slug}.md`);
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
  const status = arr(search['status']);
  if (status.length) out.push({ kind: 'status', values: status });
  const priority = str(search['priority']);
  if (priority) out.push({ kind: 'priority', value: priority });
  const labels = arr(search['labels']);
  if (labels.length) out.push({ kind: 'labels', values: labels });
  const assignee = str(search['assignee']);
  if (assignee) out.push({ kind: 'assignee', value: assignee });
  const us = str(search['updated_since']);
  if (us) out.push({ kind: 'updated_since', value: us });
  return out;
}

export function clausesToListParams(clauses: FilterClauseUrl[]): DocumentListParams {
  const p: DocumentListParams = { type: 'work_item', sort: 'updated_at', dir: 'desc' };
  for (const c of clauses) {
    if (c.kind === 'status') p.status = c.values;
    if (c.kind === 'updated_since') p.updatedSince = c.value;
    if (c.kind === 'assignee') p.assignee = c.value;
  }
  return p;
}

/** Frontmatter-side post-filter; applied to the fetched page client-side until the server exposes a generic frontmatter query (Phase 4). */
export function applyFrontmatterClauses(docs: DocumentSummary[], clauses: FilterClauseUrl[]): DocumentSummary[] {
  let out = docs;
  for (const c of clauses) {
    if (c.kind === 'priority') {
      out = out.filter((d) => d.frontmatter?.['priority'] === c.value);
    // Labels: AND semantics — every selected value must be present. Today's UI is
    // single-select so AND ≡ OR; revisit when multi-label filtering ships.
    } else if (c.kind === 'labels') {
      out = out.filter((d) => {
        const labels = d.frontmatter?.['labels'];
        if (!Array.isArray(labels)) return false;
        return c.values.every((v) => (labels as unknown[]).includes(v));
      });
    }
    // 'assignee' is sent to server; nothing to do client-side.
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
