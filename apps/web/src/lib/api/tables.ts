import { useQuery } from '@tanstack/react-query';
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
