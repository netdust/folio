import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client.ts';

export interface View {
  id: string;
  name: string;
  type: 'table' | 'list' | 'kanban' | 'calendar' | 'timeline' | 'gallery';
  filters: unknown;
  sort: unknown;
  groupBy: string | null;
  visibleFields: string[] | null;
  columnOrder: string[] | null;
  // Per-view typed config (e.g. { dateField } for a calendar view). NOT NULL
  // default {} on the column, so always an object on read — never null.
  settings: Record<string, unknown>;
  isDefault: boolean;
  order: number;
}

export const viewsKeys = {
  list: (wslug: string, pslug: string, tslug: string) => ['views', wslug, pslug, tslug] as const,
  // Batched project-views key (M3 audit 3.5): one query per PROJECT covering all
  // its tables, keyed by the sorted table slugs so it re-fetches when the table
  // set changes. Distinct namespace ('views-batch') so it never collides with the
  // per-table `list` keys the rest of the app invalidates.
  batch: (wslug: string, pslug: string, tslugs: string[]) =>
    ['views-batch', wslug, pslug, [...tslugs].sort().join(',')] as const,
  // Prefix for invalidating ALL of a project's batched views regardless of the
  // table-slug suffix — used after a view rename/delete/reorder so the rail's
  // batched query (keyed by the full table-slug set) refetches. A per-table
  // `viewsKeys.list` invalidation does NOT reach the batch query.
  batchPrefix: (wslug: string, pslug: string) => ['views-batch', wslug, pslug] as const,
};

/**
 * Batched fetch: all views for the given tables of ONE project, grouped by
 * tableId. Collapses the rail's per-(project,table) fan-out into one request per
 * project (server: GET /p/:pslug/views?tables=slugA,slugB). The server intersects
 * the requested slugs with the project's own tables, so the result is keyed by
 * the project's table ids only.
 */
export function fetchProjectViews(
  wslug: string,
  pslug: string,
  tslugs: string[],
): Promise<Record<string, View[]>> {
  const qs = encodeURIComponent(tslugs.join(','));
  return client.get<Record<string, View[]>>(`/api/v1/w/${wslug}/p/${pslug}/views?tables=${qs}`);
}

export function useViews(wslug: string, pslug: string, tslug: string) {
  return useQuery({
    queryKey: viewsKeys.list(wslug, pslug, tslug),
    queryFn: () => client.get<View[]>(`/api/v1/w/${wslug}/p/${pslug}/t/${tslug}/views`),
    staleTime: 5 * 60_000,
    enabled: !!wslug && !!pslug && !!tslug,
  });
}

export interface ViewCreate {
  name: string;
  type: 'table' | 'list' | 'kanban' | 'calendar' | 'timeline' | 'gallery';
  filters?: unknown;
  sort?: unknown;
  visibleFields?: string[];
  columnOrder?: string[] | null;
  groupBy?: string | null;
  settings?: Record<string, unknown> | null;
  isDefault?: boolean;
  order?: number;
}

export function useCreateView(wslug: string, pslug: string, tslug: string) {
  const qc = useQueryClient();
  return useMutation({
    // Server returns `{ data: { view: row } }`; the `data` envelope is stripped
    // by client.post but the inner `{ view: row }` is not — unwrap explicitly.
    mutationFn: async (payload: ViewCreate): Promise<View> => {
      const wrapped = await client.post<{ view: View }>(
        `/api/v1/w/${wslug}/p/${pslug}/t/${tslug}/views`,
        payload,
      );
      return wrapped.view;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: viewsKeys.list(wslug, pslug, tslug) });
      // The rail reads the batched per-project views query — invalidate its
      // prefix so a newly-created view appears in the rail (a per-table `list`
      // invalidation does not reach the batch key).
      qc.invalidateQueries({ queryKey: viewsKeys.batchPrefix(wslug, pslug) });
    },
  });
}

export interface ViewPatch {
  name?: string;
  type?: 'table' | 'list' | 'kanban' | 'calendar' | 'timeline' | 'gallery';
  filters?: unknown;
  sort?: unknown;
  groupBy?: string | null;
  visibleFields?: string[];
  columnOrder?: string[] | null;
  settings?: Record<string, unknown> | null;
  isDefault?: boolean;
  order?: number;
}

export function useUpdateView(wslug: string, pslug: string, tslug: string) {
  const qc = useQueryClient();
  return useMutation({
    // Server PATCH returns `{ data: { view: row } }`; client.patch strips the
    // outer `data` envelope but not the inner `view` key. Mirror the
    // unwrap pattern in useCreateView and useUpdateField.
    mutationFn: async ({ id, patch }: { id: string; patch: ViewPatch }): Promise<View> => {
      const wrapped = await client.patch<{ view: View }>(
        `/api/v1/w/${wslug}/p/${pslug}/t/${tslug}/views/${id}`,
        patch,
      );
      return wrapped.view;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: viewsKeys.list(wslug, pslug, tslug) });
      // Accepted cost: filter/sort/groupBy autosave also flows through here and
      // triggers a rail batch refetch even though those fields don't change what
      // the rail renders (only name/order/existence do). Correctness-safe and
      // bounded by staleTime; not worth a "rail-visible field changed" guard.
      qc.invalidateQueries({ queryKey: viewsKeys.batchPrefix(wslug, pslug) });
    },
  });
}

export function useDeleteView(wslug: string, pslug: string, tslug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (viewId: string) =>
      client.delete(`/api/v1/w/${wslug}/p/${pslug}/t/${tslug}/views/${viewId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: viewsKeys.list(wslug, pslug, tslug) });
      qc.invalidateQueries({ queryKey: viewsKeys.batchPrefix(wslug, pslug) });
    },
  });
}
