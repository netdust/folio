import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client.ts';

export type FieldType =
  | 'string'
  | 'text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'select'
  | 'multi_select'
  | 'user_ref'
  | 'url'
  | 'document_ref'
  | 'currency';

export interface Field {
  id: string;
  key: string;
  type: FieldType;
  label: string | null;
  options: string[] | null;
  required: boolean;
  order: number;
}

export const fieldsKeys = {
  list: (wslug: string, pslug: string, tslug: string) =>
    ['fields', wslug, pslug, tslug] as const,
};

export function useFields(wslug: string, pslug: string, tslug: string) {
  return useQuery({
    queryKey: fieldsKeys.list(wslug, pslug, tslug),
    queryFn: () =>
      client.get<Field[]>(`/api/v1/w/${wslug}/p/${pslug}/t/${tslug}/fields`),
    staleTime: 5 * 60_000,
    enabled: !!wslug && !!pslug && !!tslug,
  });
}

export interface FieldCreate {
  key: string;
  type: FieldType;
  label?: string;
  options?: string[];
  order?: number;
}

export interface FieldPatch {
  key?: string;
  type?: FieldType;
  label?: string;
  options?: string[];
  order?: number;
}

export function useCreateField(wslug: string, pslug: string, tslug: string) {
  const qc = useQueryClient();
  return useMutation({
    // Server returns `{ data: { field: row } }`; the `data` envelope is stripped
    // by client.post but the inner `{ field: row }` is not — unwrap explicitly.
    mutationFn: async (payload: FieldCreate): Promise<Field> => {
      const wrapped = await client.post<{ field: Field }>(
        `/api/v1/w/${wslug}/p/${pslug}/t/${tslug}/fields`,
        payload,
      );
      return wrapped.field;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: fieldsKeys.list(wslug, pslug, tslug) });
    },
  });
}

export function useUpdateField(wslug: string, pslug: string, tslug: string) {
  const qc = useQueryClient();
  return useMutation({
    // Server returns `{ data: { field: row } }`; the `data` envelope is stripped
    // by client.patch but the inner `{ field: row }` is not — unwrap explicitly.
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: FieldPatch;
    }): Promise<Field> => {
      const wrapped = await client.patch<{ field: Field }>(
        `/api/v1/w/${wslug}/p/${pslug}/t/${tslug}/fields/${id}`,
        patch,
      );
      return wrapped.field;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: fieldsKeys.list(wslug, pslug, tslug) });
    },
  });
}

export function useDeleteField(wslug: string, pslug: string, tslug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      client.delete(`/api/v1/w/${wslug}/p/${pslug}/t/${tslug}/fields/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: fieldsKeys.list(wslug, pslug, tslug) });
    },
  });
}
