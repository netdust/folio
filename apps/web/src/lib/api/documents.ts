import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client.ts';
import { useOptimisticPatch } from './optimistic.ts';

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
  return useOptimisticPatch<Document, { slug: string; patch: DocumentPatch }>({
    detailKey: ({ slug }) => documentsKeys.detail(wslug, pslug, slug),
    listKey: documentsKeys.list(wslug, pslug, listParams),
    mutationFn: ({ slug, patch }) =>
      client.patch<Document>(`/api/v1/w/${wslug}/p/${pslug}/documents/${slug}`, patch),
    applyToDetail: (prev, { patch }) => ({
      ...prev,
      ...patch,
      frontmatter: { ...prev.frontmatter, ...(patch.frontmatter ?? {}) },
    }),
    // applyToList omitted intentionally — the list query returns DocumentListPage
    // (not a flat array), so the generic optimistic helper's TData[] shape doesn't fit.
    // Task 13 upgrades this hook to patch the list page directly.
    // For Task 4, only the detail cache is patched optimistically; the list re-fetches
    // via onSettled.invalidate.
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
