import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client.ts';

export type DocumentType = 'work_item' | 'page';

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
}

export interface Document extends DocumentSummary {
  body: string;
}

export interface DocumentListPage {
  data: DocumentSummary[];
  nextCursor: string | null;
}

export interface DocumentListParams {
  type?: DocumentType;
  status?: string[];
  assignee?: string;
  updatedSince?: string;
  sort?: 'updated_at' | 'title' | 'priority' | 'status';
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

export function useDocuments(wslug: string, pslug: string, params: DocumentListParams = {}) {
  return useQuery({
    queryKey: documentsKeys.list(wslug, pslug, params),
    queryFn: () =>
      client.get<DocumentListPage>(`/api/v1/w/${wslug}/p/${pslug}/documents${toSearch(params)}`),
    staleTime: 30_000,
    enabled: !!wslug && !!pslug,
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
          frontmatter: { ...prevDetail.frontmatter, ...(patch.frontmatter ?? {}) },
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
                  frontmatter: { ...d.frontmatter, ...(patch.frontmatter ?? {}) },
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
    onSettled: (_data, _err, { slug }) => {
      qc.invalidateQueries({ queryKey: documentsKeys.detail(wslug, pslug, slug) });
      qc.invalidateQueries({ queryKey: listKey });
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
