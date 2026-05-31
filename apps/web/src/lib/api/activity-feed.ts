import { useMemo, useRef, useState } from 'react';
import { useEventStream, type StreamedEvent } from './event-stream.ts';
import { useWorkspaceRuns } from './runs.ts';

export interface ActivityItem {
  runDocId: string;
  agent: string;
  status: string;
  firedBy?: string;
  at: number;
}

const RUN_KINDS = [
  'agent.run.started',
  'agent.run.awaiting_approval',
  'agent.run.running',
  'agent.run.completed',
  'agent.run.failed',
  'agent.run.rejected',
] as const;
const CAP = 50;

// Agent activity feed. Two sources, merged: a history backfill from the
// workspace recent-runs endpoint (useWorkspaceRuns) seeds past runs on mount,
// and an SSE live-tail layers fresh `agent.run.*` transitions on top. The
// returned list is the union deduped by run doc id — a live transition always
// supersedes the historical row for the same run. Justified local live-tail
// state (like useReactorHealth); history comes from react-query.
export function useActivityFeed(wslug: string): { items: ActivityItem[] } {
  const historyQuery = useWorkspaceRuns(wslug, { limit: CAP });

  // Live deltas arriving after mount, keyed by run doc id (live wins on merge).
  // `seq` is a monotonic arrival counter so two events landing in the same
  // millisecond still order by arrival (newest-first) — Date.now() alone ties.
  const [live, setLive] = useState<Map<string, ActivityItem & { seq: number }>>(new Map());
  const seqRef = useRef(0);

  useEventStream(wslug, { kinds: [...RUN_KINDS] }, (e: StreamedEvent) => {
    const runDocId = e.documentId ?? '';
    if (!runDocId) return;
    const p = (e.payload ?? {}) as { agent?: string; to?: string; fired_by?: string };
    const status = p.to ?? e.kind.replace('agent.run.', ''); // started → 'started'
    seqRef.current += 1;
    const seq = seqRef.current;
    setLive((prev) => {
      // Only agent.run.started carries payload.fired_by; transition emits omit
      // it. Carry the prior row's firedBy forward so the "Triggered by" label
      // survives status advances instead of flickering to undefined.
      const existing = prev.get(runDocId);
      const next = new Map(prev);
      next.set(runDocId, {
        runDocId,
        agent: p.agent ?? '—',
        status,
        firedBy: p.fired_by ?? existing?.firedBy,
        at: Date.now(),
        seq,
      });
      return next;
    });
  });

  const items = useMemo<ActivityItem[]>(() => {
    // Seed from history (seq 0 — sorts behind any live event on an `at` tie).
    const merged = new Map<string, ActivityItem & { seq: number }>();
    for (const r of historyQuery.data ?? []) {
      const fm = r.frontmatter as { agent_slug?: string; fired_by?: string };
      merged.set(r.id, {
        runDocId: r.id,
        agent: fm.agent_slug ?? '—',
        status: r.status ?? 'unknown',
        firedBy: fm.fired_by,
        at: r.updatedAt ? Date.parse(r.updatedAt) : 0,
        seq: 0,
      });
    }
    // Live wins — overwrite the historical row for the same run.
    for (const [id, item] of live) merged.set(id, item);

    return [...merged.values()]
      .sort((a, b) => b.at - a.at || b.seq - a.seq)
      .slice(0, CAP)
      .map(({ seq: _seq, ...item }) => item);
  }, [historyQuery.data, live]);

  return { items };
}
