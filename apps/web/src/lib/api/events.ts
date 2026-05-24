import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client.ts';

export interface DocumentEvent {
  id: string;
  workspaceId: string;
  projectId: string | null;
  documentId: string | null;
  kind: string;
  actor: string | null;
  payload: unknown;
  createdAt: string;
}

export const documentEventsKeys = {
  list: (wslug: string, pslug: string, slug: string) =>
    ['document-events', wslug, pslug, slug] as const,
};

export function useDocumentEvents(wslug: string, pslug: string, slug: string | undefined) {
  return useQuery({
    queryKey: documentEventsKeys.list(wslug, pslug, slug ?? ''),
    queryFn: () =>
      client.get<DocumentEvent[]>(`/api/v1/w/${wslug}/p/${pslug}/documents/${slug}/events`),
    enabled: !!wslug && !!pslug && !!slug,
    staleTime: 30_000,
  });
}

export function useLogActivity(wslug: string, pslug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, note }: { slug: string; note: string }) =>
      client.post<{ lastTouchedAt: string }>(
        `/api/v1/w/${wslug}/p/${pslug}/documents/${slug}/activity`,
        { note },
      ),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: documentEventsKeys.list(wslug, pslug, vars.slug) });
      // Also bust the document itself since lastTouchedAt changed.
      qc.invalidateQueries({ queryKey: ['documents'] });
    },
  });
}
