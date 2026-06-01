import { useQueryClient } from '@tanstack/react-query';
import { documentsKeys } from './documents.ts';
import { useEventStream } from './event-stream.ts';

const DOCUMENT_KINDS = ['document.created', 'document.updated', 'document.deleted'] as const;

/**
 * Live-update the list/board/table views: on any document write in this project,
 * invalidate the documents list query so react-query refetches the active
 * (filtered/sorted/paginated) variant. Mount ONCE at the project route — prefix
 * invalidation refetches whichever view variant is mounted. Owns no state.
 */
export function useLiveDocuments(wslug: string, pslug: string): void {
  const qc = useQueryClient();
  useEventStream(wslug, { project: pslug, kinds: [...DOCUMENT_KINDS] }, () => {
    qc.invalidateQueries({ queryKey: [...documentsKeys.all, wslug, pslug, 'list'] });
  });
}
