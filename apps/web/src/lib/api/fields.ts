import { useQuery } from '@tanstack/react-query';
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
  | 'document_ref';

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
  list: (wslug: string, pslug: string) => ['fields', wslug, pslug] as const,
};

export function useFields(wslug: string, pslug: string) {
  return useQuery({
    queryKey: fieldsKeys.list(wslug, pslug),
    queryFn: () => client.get<Field[]>(`/api/v1/w/${wslug}/p/${pslug}/fields`),
    staleTime: 5 * 60_000,
    enabled: !!wslug && !!pslug,
  });
}
