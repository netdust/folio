import { useQuery } from '@tanstack/react-query';
import { client } from './client.ts';

export interface BacklinkRow {
  id: string;
  slug: string;
  title: string;
  type: string;
  tableId: string | null;
}

export const backlinksKeys = {
  list: (wslug: string, pslug: string, slug: string) =>
    ['backlinks', wslug, pslug, slug] as const,
};

export function useBacklinks(wslug: string, pslug: string, slug: string) {
  return useQuery({
    queryKey: backlinksKeys.list(wslug, pslug, slug),
    queryFn: () =>
      client.get<BacklinkRow[]>(
        `/api/v1/w/${wslug}/p/${pslug}/documents/${slug}/backlinks`,
      ),
    staleTime: 30_000,
    enabled: !!wslug && !!pslug && !!slug,
  });
}
