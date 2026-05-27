import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client, type ApiError } from './client.ts';

// ---------------------------------------------------------------------------
// Types — defined locally; TODO: move CommentKind/CommentVisibility/ResolvedMention
// to @folio/shared when comment types are stabilised across server + web.
// These mirror apps/server/src/lib/comment-schema.ts exactly.
// ---------------------------------------------------------------------------

export type CommentKind =
  | 'comment'
  | 'plan'
  | 'result'
  | 'error'
  | 'approval'
  | 'rejection'
  | 'reply';

export type CommentVisibility = 'normal' | 'internal';

export interface ResolvedMention {
  target: string;
  resolved: boolean;
  resolvedId?: string;
  resolvedType?: 'agent' | 'user';
}

export interface CommentFrontmatter {
  author: string;
  kind: CommentKind;
  visibility: CommentVisibility;
  mentions: ResolvedMention[];
  edited_at?: string;
  target_agent?: string;
  run_id?: string;
  deleted_at?: string;
}

export interface Comment {
  id: string;
  slug: string;
  type: 'comment';
  title: string;
  parentId: string;
  projectId: string;
  workspaceId: string;
  body: string;
  frontmatter: CommentFrontmatter;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface ListCommentsParams {
  kind?: CommentKind | CommentKind[];
  since?: string;
  visibility?: CommentVisibility[];
}

export interface CreateCommentVars {
  body: string;
  kind?: CommentKind;
  target_agent?: string;
  visibility?: CommentVisibility;
}

export interface UpdateCommentVars {
  slug: string;
  body?: string;
  visibility?: CommentVisibility;
}

// ---------------------------------------------------------------------------
// Query key factory
// ---------------------------------------------------------------------------

export const commentsKeys = {
  all: ['comments'] as const,
  list: (wslug: string, pslug: string, parentSlug: string, params?: ListCommentsParams) =>
    [...commentsKeys.all, wslug, pslug, parentSlug, 'list', params ?? {}] as const,
};

// ---------------------------------------------------------------------------
// Query string builder
// ---------------------------------------------------------------------------

function toSearch(params: ListCommentsParams): string {
  const sp = new URLSearchParams();
  if (params.kind !== undefined) {
    const kinds = (Array.isArray(params.kind) ? params.kind : [params.kind]).filter(Boolean);
    if (kinds.length > 0) sp.set('kind', kinds.join(','));
  }
  if (params.visibility !== undefined) {
    const visibilities = params.visibility.filter(Boolean);
    if (visibilities.length > 0) sp.set('visibility', visibilities.join(','));
  }
  if (params.since) sp.set('since', params.since);
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useComments(
  wslug: string,
  pslug: string,
  parentSlug: string,
  params?: ListCommentsParams,
) {
  return useQuery({
    queryKey: commentsKeys.list(wslug, pslug, parentSlug, params),
    queryFn: () =>
      client.get<Comment[]>(
        `/api/v1/w/${wslug}/p/${pslug}/documents/${parentSlug}/comments${toSearch(params ?? {})}`,
      ),
    staleTime: 30_000,
    enabled: !!wslug && !!pslug && !!parentSlug,
  });
}

export function useCreateComment(wslug: string, pslug: string, parentSlug: string) {
  const qc = useQueryClient();
  const listKeyPrefix = [...commentsKeys.all, wslug, pslug, parentSlug, 'list'] as const;

  return useMutation<Comment, ApiError, CreateCommentVars>({
    mutationFn: (vars) =>
      client.post<Comment>(`/api/v1/w/${wslug}/p/${pslug}/documents/${parentSlug}/comments`, vars),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: listKeyPrefix });
      const snapshots = qc.getQueriesData<Comment[]>({ queryKey: listKeyPrefix });

      // Build an optimistic comment with a temporary id/slug/timestamps.
      // The server will replace these on success + invalidation.
      // BUG-020 — use crypto.randomUUID() so two mutations firing in the
      // same millisecond (automation, double-click, agent batch) get
      // distinct ids. The prior `optimistic-${Date.now()}` form collided
      // and produced duplicate React keys; the second render dropped a
      // row and the user's first message could briefly disappear.
      const optimisticId = crypto.randomUUID();
      const now = new Date().toISOString();
      const optimistic: Comment = {
        id: optimisticId,
        slug: optimisticId,
        type: 'comment',
        title: '',
        parentId: parentSlug,
        projectId: '',
        workspaceId: '',
        body: vars.body,
        frontmatter: {
          author: 'user:optimistic',
          kind: vars.kind ?? 'comment',
          visibility: vars.visibility ?? 'normal',
          mentions: [],
          ...(vars.target_agent ? { target_agent: vars.target_agent } : {}),
        },
        createdAt: now,
        updatedAt: now,
      };

      for (const [key, data] of snapshots) {
        if (data) qc.setQueryData(key, [optimistic, ...data]);
      }

      return { snapshots };
    },
    onError: (_err, _vars, ctx) => {
      const context = ctx as { snapshots?: [readonly unknown[], Comment[] | undefined][] } | undefined;
      for (const [key, data] of context?.snapshots ?? []) {
        qc.setQueryData(key as readonly unknown[], data);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: listKeyPrefix });
    },
  });
}

export function useUpdateComment(wslug: string, pslug: string) {
  const qc = useQueryClient();
  const wsProjectPrefix = [...commentsKeys.all, wslug, pslug] as const;

  return useMutation<Comment, ApiError, UpdateCommentVars>({
    mutationFn: ({ slug, body, visibility }) =>
      client.patch<Comment>(`/api/v1/w/${wslug}/p/${pslug}/comments/${slug}`, {
        ...(body !== undefined ? { body } : {}),
        ...(visibility !== undefined ? { visibility } : {}),
      }),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: wsProjectPrefix });
      // Walk all list caches for this wslug/pslug (any parentSlug)
      const snapshots = qc.getQueriesData<Comment[]>({ queryKey: wsProjectPrefix });
      const now = new Date().toISOString();

      for (const [key, data] of snapshots) {
        if (!data) continue;
        const updated = data.map((c) => {
          if (c.slug !== vars.slug) return c;
          return {
            ...c,
            body: vars.body ?? c.body,
            frontmatter: {
              ...c.frontmatter,
              ...(vars.visibility !== undefined ? { visibility: vars.visibility } : {}),
              edited_at: now,
            },
          };
        });
        qc.setQueryData(key, updated);
      }

      return { snapshots };
    },
    onError: (_err, _vars, ctx) => {
      const context = ctx as { snapshots?: [readonly unknown[], Comment[] | undefined][] } | undefined;
      for (const [key, data] of context?.snapshots ?? []) {
        qc.setQueryData(key as readonly unknown[], data);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: wsProjectPrefix });
    },
  });
}

export function useDeleteComment(wslug: string, pslug: string) {
  const qc = useQueryClient();
  const wsProjectPrefix = [...commentsKeys.all, wslug, pslug] as const;

  return useMutation<Comment, ApiError, { slug: string }>({
    mutationFn: ({ slug }) =>
      client.delete<Comment>(`/api/v1/w/${wslug}/p/${pslug}/comments/${slug}`),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: wsProjectPrefix });
      const snapshots = qc.getQueriesData<Comment[]>({ queryKey: wsProjectPrefix });
      const now = new Date().toISOString();

      for (const [key, data] of snapshots) {
        if (!data) continue;
        const updated = data.map((c) => {
          if (c.slug !== vars.slug) return c;
          return {
            ...c,
            body: '',
            frontmatter: {
              ...c.frontmatter,
              deleted_at: now,
            },
          };
        });
        qc.setQueryData(key, updated);
      }

      return { snapshots };
    },
    onError: (_err, _vars, ctx) => {
      const context = ctx as { snapshots?: [readonly unknown[], Comment[] | undefined][] } | undefined;
      for (const [key, data] of context?.snapshots ?? []) {
        qc.setQueryData(key as readonly unknown[], data);
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: wsProjectPrefix });
    },
  });
}
