import { useQueryClient } from '@tanstack/react-query';
import { documentsKeys } from './documents.ts';
import { useEventStream } from './event-stream.ts';

const DOCUMENT_KINDS = ['document.created', 'document.updated', 'document.deleted'] as const;

/**
 * Live-update the list/board/table views: on any document write in this project,
 * invalidate the documents list query so react-query refetches the active
 * (filtered/sorted/paginated) variant. Mount ONCE at the project route — prefix
 * invalidation refetches whichever view variant is mounted. Owns no state.
 *
 * `projectId` (NOT the slug) is the SSE filter: the /events route matches
 * `?project=` against the event row's projectId (a real id), so passing the slug
 * silently drops every event. The cache key, by contrast, is slug-based
 * (documentsKeys.list keys on pslug). Two identifiers, two purposes.
 * `projectId` is undefined while the project query is loading — the filter omits
 * it then (buildQuery skips falsy filters) and useEventStream reconnects with the
 * scoped filter once the id resolves.
 */
export function useLiveDocuments(
  wslug: string,
  pslug: string,
  projectId: string | undefined,
): void {
  const qc = useQueryClient();
  useEventStream(wslug, { project: projectId, kinds: [...DOCUMENT_KINDS] }, () => {
    // The SSE event does NOT carry the changed doc's table, so invalidate
    // across ALL tables of the project: [...all, wslug, pslug] prefix-matches
    // every table list key [...all, w, p, <tslug>, 'list', <params>]. (The old
    // [...all, w, p, 'list'] prefix stopped matching once tslug was inserted at
    // index 3, silently dropping every live refetch.)
    qc.invalidateQueries({ queryKey: [...documentsKeys.all, wslug, pslug] });
  });
}
