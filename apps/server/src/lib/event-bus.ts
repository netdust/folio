import type { EventKind } from './events.ts';

export interface BusEvent {
  id?: string;             // optional; SSE assigns one on emit if absent
  workspaceId: string;
  projectId?: string | null;
  documentId?: string | null;
  kind: EventKind;
  actor?: string;
  payload?: unknown;
  createdAt?: number;      // unix ms; defaults to Date.now()
}

export interface SubFilter {
  kinds?: EventKind[];
  projectId?: string;
}

type Handler = (e: BusEvent) => void;
interface Sub {
  workspaceId: string;
  filter: SubFilter | undefined;
  handler: Handler;
}

/** Single in-process bus. The instance is exported as `eventBus`. */
class EventBus {
  private subs = new Set<Sub>();

  subscribe(workspaceId: string, filter: SubFilter | undefined, handler: Handler): () => void {
    const sub: Sub = { workspaceId, filter, handler };
    this.subs.add(sub);
    return () => this.subs.delete(sub);
  }

  publish(e: BusEvent): void {
    for (const sub of this.subs) {
      if (sub.workspaceId !== e.workspaceId) continue;
      if (sub.filter?.kinds && !sub.filter.kinds.includes(e.kind)) continue;
      if (sub.filter?.projectId !== undefined && sub.filter.projectId !== e.projectId) continue;
      try {
        sub.handler(e);
      } catch {
        // Swallow per-subscriber errors so one bad handler can't take down the bus.
      }
    }
  }

  /** Test-only escape hatch. Not exported through the barrel. */
  __clear(): void {
    this.subs.clear();
  }
}

export const eventBus = new EventBus();
