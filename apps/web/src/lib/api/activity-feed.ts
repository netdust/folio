import { useState } from 'react';
import { useEventStream, type StreamedEvent } from './event-stream.ts';

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

// Live-tail feed of agent activity. SSE is the only source (no workspace-wide
// runs-list endpoint); items accrue from live events, deduped by run doc id.
// Justified local live-tail state (like useReactorHealth) — documented.
export function useActivityFeed(wslug: string): { items: ActivityItem[] } {
  const [items, setItems] = useState<ActivityItem[]>([]);
  useEventStream(wslug, { kinds: [...RUN_KINDS] }, (e: StreamedEvent) => {
    const runDocId = e.documentId ?? '';
    if (!runDocId) return;
    const p = (e.payload ?? {}) as { agent?: string; to?: string; fired_by?: string };
    const status = p.to ?? e.kind.replace('agent.run.', ''); // started → 'started'
    setItems((prev) => {
      // Only agent.run.started carries payload.fired_by; transition emits omit
      // it. Carry the prior row's firedBy forward so the "Triggered by" label
      // survives status advances instead of flickering to undefined.
      const existing = prev.find((it) => it.runDocId === runDocId);
      const next = prev.filter((it) => it.runDocId !== runDocId);
      next.unshift({ runDocId, agent: p.agent ?? '—', status, firedBy: p.fired_by ?? existing?.firedBy, at: Date.now() });
      return next.slice(0, CAP);
    });
  });
  return { items };
}
