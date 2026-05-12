import { useQuery } from '@tanstack/react-query';
import { client } from './client.ts';

export interface View {
  id: string;
  slug: string;
  name: string;
  type: 'list' | 'kanban';
  filters: unknown;
  sort: unknown;
  groupBy: string | null;
  visibleFields: string[] | null;
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
