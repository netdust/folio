import { useQuery } from '@tanstack/react-query';
import { client } from './client.ts';

export interface Status {
  id: string;
  key: string;
  name: string;
  color: string;
  category: 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled';
  order: number;
}

export const statusesKeys = {
  list: (wslug: string, pslug: string, tslug: string) =>
    ['statuses', wslug, pslug, tslug] as const,
};

export function useStatuses(wslug: string, pslug: string, tslug: string) {
  return useQuery({
    queryKey: statusesKeys.list(wslug, pslug, tslug),
    queryFn: () =>
      client.get<Status[]>(`/api/v1/w/${wslug}/p/${pslug}/t/${tslug}/statuses`),
    staleTime: 5 * 60_000,
    enabled: !!wslug && !!pslug && !!tslug,
  });
}
