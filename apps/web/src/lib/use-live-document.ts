import { useState } from 'react';
import { useEventStream, type StreamedEvent } from './api/event-stream.ts';

export interface ExternalUpdate {
  kind: 'updated' | 'deleted';
  actor: string | null;
}

export interface UseLiveDocumentArgs {
  wslug: string;
  docId: string;
  /** Current draft dirty state (from useDocumentDraft). */
  isDirty: boolean;
  /** Called to pull server truth when it is safe (clean draft, updated event). */
  onRefetch: () => void;
}

/**
 * Notify-don't-stomp live updates for the open slideover document.
 * - document.updated + CLEAN draft → onRefetch() (pull server truth, no banner).
 * - document.updated + DIRTY draft → set externalUpdate banner, NEVER refetch
 *   (would overwrite unsaved typing — the refetch-stomp the buffered-save work fixed).
 * - document.deleted → banner regardless of dirty.
 * Events for other document ids are ignored.
 *
 * NOTE (v1, last-write-wins): the banner makes the race VISIBLE; it does not
 * prevent a subsequent Save from overwriting the external edit. There is no
 * server-side conflict guard — that is a deferred follow-up.
 */
export function useLiveDocument({ wslug, docId, isDirty, onRefetch }: UseLiveDocumentArgs): {
  externalUpdate: ExternalUpdate | null;
  dismiss: () => void;
} {
  const [externalUpdate, setExternalUpdate] = useState<ExternalUpdate | null>(null);

  useEventStream(wslug, { kinds: ['document.updated', 'document.deleted'] }, (e: StreamedEvent) => {
    if (e.documentId !== docId) return;
    if (e.kind === 'document.deleted') {
      setExternalUpdate({ kind: 'deleted', actor: e.actor ?? null });
      return;
    }
    // document.updated
    if (isDirty) {
      setExternalUpdate({ kind: 'updated', actor: e.actor ?? null });
    } else {
      onRefetch();
    }
  });

  return { externalUpdate, dismiss: () => setExternalUpdate(null) };
}
