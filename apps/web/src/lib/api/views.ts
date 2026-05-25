import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client.ts';

export interface View {
  id: string;
  name: string;
  type: 'list' | 'kanban';
  filters: unknown;
  sort: unknown;
  groupBy: string | null;
  visibleFields: string[] | null;
  columnOrder: string[] | null;
  isDefault: boolean;
  order: number;
}

export const viewsKeys = {
  list: (wslug: string, pslug: string) => ['views', wslug, pslug] as const,
};

export function useViews(wslug: string, pslug: string) {
  return useQuery({
    queryKey: viewsKeys.list(wslug, pslug),
    queryFn: () => client.get<View[]>(`/api/v1/w/${wslug}/p/${pslug}/views`),
    staleTime: 5 * 60_000,
    enabled: !!wslug && !!pslug,
  });
}

export interface ViewCreate {
  name: string;
  type: 'list' | 'kanban';
  filters?: unknown;
  sort?: unknown;
  visibleFields?: string[];
  columnOrder?: string[] | null;
  groupBy?: string | null;
  isDefault?: boolean;
  order?: number;
}

export function useCreateView(wslug: string, pslug: string) {
  const qc = useQueryClient();
  return useMutation({
    // Server returns `{ data: { view: row } }`; the `data` envelope is stripped
    // by client.post but the inner `{ view: row }` is not — unwrap explicitly.
    mutationFn: async (payload: ViewCreate): Promise<View> => {
      const wrapped = await client.post<{ view: View }>(
        `/api/v1/w/${wslug}/p/${pslug}/views`,
        payload,
      );
      return wrapped.view;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: viewsKeys.list(wslug, pslug) });
    },
  });
}

export interface ViewPatch {
  name?: string;
  type?: 'list' | 'kanban';
  filters?: unknown;
  sort?: unknown;
  groupBy?: string | null;
  visibleFields?: string[];
  columnOrder?: string[] | null;
  isDefault?: boolean;
  order?: number;
}

export function useUpdateView(wslug: string, pslug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: ViewPatch }) => {
      return client.patch<View>(`/api/v1/w/${wslug}/p/${pslug}/views/${id}`, patch);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: viewsKeys.list(wslug, pslug) }),
  });
}

export function useDeleteView(wslug: string, pslug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (viewId: string) =>
      client.delete(`/api/v1/w/${wslug}/p/${pslug}/views/${viewId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: viewsKeys.list(wslug, pslug) });
    },
  });
}
