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
