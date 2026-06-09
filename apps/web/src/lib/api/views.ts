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
  list: (wslug: string, pslug: string, tslug: string) =>
    ['views', wslug, pslug, tslug] as const,
};

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
  type: 'list' | 'kanban';
  filters?: unknown;
  sort?: unknown;
  visibleFields?: string[];
  columnOrder?: string[] | null;
  groupBy?: string | null;
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
    onSuccess: () => qc.invalidateQueries({ queryKey: viewsKeys.list(wslug, pslug, tslug) }),
  });
}

export function useDeleteView(wslug: string, pslug: string, tslug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (viewId: string) =>
      client.delete(`/api/v1/w/${wslug}/p/${pslug}/t/${tslug}/views/${viewId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: viewsKeys.list(wslug, pslug, tslug) });
    },
  });
}
