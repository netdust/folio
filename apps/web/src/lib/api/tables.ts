import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client.ts';

export interface Table {
  id: string;
  slug: string;
  name: string;
  icon: string | null;
  order: number;
}

export const tablesKeys = {
  list: (wslug: string, pslug: string) => ['tables', wslug, pslug] as const,
};

export function useTables(wslug: string, pslug: string) {
  return useQuery({
    queryKey: tablesKeys.list(wslug, pslug),
    queryFn: () => client.get<Table[]>(`/api/v1/w/${wslug}/p/${pslug}/tables`),
    staleTime: 5 * 60_000,
    enabled: !!wslug && !!pslug,
  });
}

export interface TableCreate {
  name: string;
  slug?: string;
  icon?: string | null;
  order?: number;
}

export function useCreateTable(wslug: string, pslug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: TableCreate) =>
      client.post<Table>(`/api/v1/w/${wslug}/p/${pslug}/tables`, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tablesKeys.list(wslug, pslug) });
    },
  });
}

export interface TablePatch {
  name?: string;
  icon?: string | null;
  order?: number;
}

export function useUpdateTable(wslug: string, pslug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ tslug, patch }: { tslug: string; patch: TablePatch }) =>
      client.patch<Table>(`/api/v1/w/${wslug}/p/${pslug}/tables/${tslug}`, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tablesKeys.list(wslug, pslug) });
    },
  });
}

export function useDeleteTable(wslug: string, pslug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tslug: string) =>
      client.delete(`/api/v1/w/${wslug}/p/${pslug}/tables/${tslug}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tablesKeys.list(wslug, pslug) });
    },
  });
}
