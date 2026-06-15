import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { documentsKeys } from './documents.ts';
import { useEventStream } from './event-stream.ts';

/** Trailing-debounce window: an agent write-burst collapses to ONE refetch. */
const INVALIDATE_DEBOUNCE_MS = 250;

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
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any in-flight debounce on unmount so a late timer never invalidates
  // (or touches a torn-down query client) after the route is gone.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  useEventStream(wslug, { project: projectId, kinds: [...DOCUMENT_KINDS] }, () => {
    // 250ms TRAILING debounce: an agent write-burst (N document events in quick
    // succession) collapses to ONE refetch instead of N. Each event resets the
    // window; the invalidate fires once the burst goes quiet.
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      // The SSE event does NOT carry the changed doc's table, so invalidate
      // across ALL tables of the project: [...all, wslug, pslug] prefix-matches
      // every table list key [...all, w, p, <tslug>, 'list', <params>]. (The old
      // [...all, w, p, 'list'] prefix stopped matching once tslug was inserted at
      // index 3, silently dropping every live refetch.)
      qc.invalidateQueries({ queryKey: [...documentsKeys.all, wslug, pslug] });
    }, INVALIDATE_DEBOUNCE_MS);
  });
}
