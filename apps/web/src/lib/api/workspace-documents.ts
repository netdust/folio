/**
 * Phase 2.5: workspace-scoped document hooks (agents + triggers).
 *
 * The project-scoped useDocuments hook in documents.ts no longer surfaces
 * agents/triggers — they live at /api/v1/w/:wslug/documents now.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client.ts';
import type { Document, DocumentSummary, DocumentPatch } from './documents.ts';
import type { DocumentEvent } from './events.ts';

export interface WorkspaceDocumentsListParams {
  type: 'agent' | 'trigger';
  /** Narrow to docs whose frontmatter.projects includes '*' or this project id. */
  project?: string;
}

export const workspaceDocumentsKeys = {
  all: ['workspace-documents'] as const,
  list: (wslug: string, params: WorkspaceDocumentsListParams) =>
    [...workspaceDocumentsKeys.all, wslug, 'list', params] as const,
  detail: (wslug: string, slug: string) =>
    [...workspaceDocumentsKeys.all, wslug, 'detail', slug] as const,
};

function toSearch(params: WorkspaceDocumentsListParams): string {
  const sp = new URLSearchParams({ type: params.type });
  if (params.project) sp.set('project', params.project);
  return `?${sp.toString()}`;
}

export function useWorkspaceDocuments(
  wslug: string,
  params: WorkspaceDocumentsListParams,
  options: { enabled?: boolean; keepPrevious?: boolean } = {},
) {
  return useQuery({
    queryKey: workspaceDocumentsKeys.list(wslug, params),
    // client.get auto-unwraps single-key { data } envelopes — payload is the array.
    queryFn: () =>
      client.get<DocumentSummary[]>(`/api/v1/w/${wslug}/documents${toSearch(params)}`),
    staleTime: 30_000,
    enabled: !!wslug && (options.enabled ?? true),
    // keepPrevious avoids a skeleton flash in the assignee picker when the
    // user opens it a second time — first open does fresh fetch, subsequent
    // opens show the cached list immediately while a background refresh runs.
    placeholderData: options.keepPrevious ? (prev) => prev : undefined,
  });
}

/** Convenience: workspace agents, optionally filtered to those allow-listed for a project. */
export function useWorkspaceAgents(
  wslug: string,
  opts: { project?: string; enabled?: boolean } = {},
) {
  return useWorkspaceDocuments(
    wslug,
    { type: 'agent', project: opts.project },
    { keepPrevious: true, enabled: opts.enabled },
  );
}

export function useWorkspaceTriggers(wslug: string, opts: { enabled?: boolean } = {}) {
  return useWorkspaceDocuments(wslug, { type: 'trigger' }, { enabled: opts.enabled });
}

export function useWorkspaceDocument(
  wslug: string,
  slug: string | null,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: slug ? workspaceDocumentsKeys.detail(wslug, slug) : ['workspace-documents', 'noop'],
    queryFn: () => client.get<Document>(`/api/v1/w/${wslug}/documents/${slug}`),
    staleTime: 30_000,
    enabled: !!wslug && !!slug && (options.enabled ?? true),
  });
}

/**
 * Create an agent or trigger at workspace scope. Server auto-mints a token for
 * agents and returns its plaintext as `agent_token` on the response.
 */
export function useCreateWorkspaceDocument(wslug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      type: 'agent' | 'trigger';
      title: string;
      body?: string;
      frontmatter?: Record<string, unknown>;
    }) => client.post<Document & { agent_token?: string }>(`/api/v1/w/${wslug}/documents`, vars),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: [...workspaceDocumentsKeys.all, wslug, 'list'] }),
  });
}

export function useUpdateWorkspaceDocument(wslug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, patch }: { slug: string; patch: DocumentPatch }) =>
      client.patch<Document>(`/api/v1/w/${wslug}/documents/${slug}`, patch),
    onSettled: (_data, _err, { slug }) => {
      qc.invalidateQueries({ queryKey: workspaceDocumentsKeys.detail(wslug, slug) });
      qc.invalidateQueries({ queryKey: [...workspaceDocumentsKeys.all, wslug, 'list'] });
    },
  });
}

export function useDeleteWorkspaceDocument(wslug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) =>
      client.delete<void>(`/api/v1/w/${wslug}/documents/${slug}`),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: [...workspaceDocumentsKeys.all, wslug, 'list'] }),
  });
}

// ---------------------------------------------------------------------------
// Phase 2.6 C10: workspace-scoped events + activity hooks.
//
// Sibling pattern to lib/api/events.ts but scoped to workspace docs (no pslug).
// The cache keys deliberately use a 'workspace-document-events' prefix to keep
// them disjoint from the project-scoped ['document-events'] keys — the two
// endpoints can never overlap on the same doc.
// ---------------------------------------------------------------------------

export const workspaceDocumentEventsKeys = {
  list: (wslug: string, slug: string) =>
    ['workspace-document-events', wslug, slug] as const,
};

export function useWorkspaceDocumentEvents(wslug: string, slug: string | undefined) {
  return useQuery({
    queryKey: workspaceDocumentEventsKeys.list(wslug, slug ?? ''),
    queryFn: () =>
      client.get<DocumentEvent[]>(`/api/v1/w/${wslug}/documents/${slug}/events`),
    enabled: !!wslug && !!slug,
    staleTime: 30_000,
  });
}

export function useWorkspaceLogActivity(wslug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, note }: { slug: string; note: string }) =>
      client.post<{ lastTouchedAt: string }>(
        `/api/v1/w/${wslug}/documents/${slug}/activity`,
        { note },
      ),
    onSuccess: (_data, vars) => {
      // Scope to workspace — no pslug in any key. A broad
      // ['workspace-documents'] invalidation would also bust every other
      // workspace's caches in every open tab.
      qc.invalidateQueries({
        queryKey: workspaceDocumentEventsKeys.list(wslug, vars.slug),
      });
      qc.invalidateQueries({
        queryKey: workspaceDocumentsKeys.detail(wslug, vars.slug),
      });
      qc.invalidateQueries({
        queryKey: [...workspaceDocumentsKeys.all, wslug, 'list'],
      });
    },
  });
}
