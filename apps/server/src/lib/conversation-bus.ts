/**
 * Operator cockpit chat — the per-conversation live-tail bus (Task 9a).
 *
 * A minimal in-process pub/sub keyed by `conversationId`. It is the DEDICATED,
 * instance-level, owner-scoped channel the chat live-tail rides — structurally
 * separate from `eventBus` (the trigger/document plane). It exists precisely so
 * chat turns do NOT emit `events` rows or reach the trigger-matcher (M10): the
 * conversation tables are walled off (invariant 5 deliberate exception), and so
 * is their live channel.
 *
 * Deliberately tiny compared to `eventBus`:
 *   - NO workspace key (conversations are instance-level).
 *   - NO reactors / replay / Last-Event-Id (this is live-only; the thread seeds
 *     from `GET /conversations/:id`).
 *   - One subject per id: a `Map<conversationId, Set<callback>>`.
 *
 * The message SINK (`chat-thread-sink.ts`) publishes each appended row here so a
 * live subscriber (`GET /conversations/:id/stream`) sees it. Ownership/auth is
 * enforced at the SSE route (owner-scoped 404), not in the bus.
 */

import type { SerializedMessage } from '../services/conversations.ts';

// The bus carries the WIRE shape (createdAt as unix-ms number), not the raw DB
// `Message` (createdAt as Date) — Cluster-5 /code-review fix (finding #3): the
// SSE route JSON.stringifies whatever the bus delivers, so the conversion to the
// declared wire type must happen at publish, once, not per consumer.
type MessageHandler = (row: SerializedMessage) => void;

class ConversationBus {
  private subs = new Map<string, Set<MessageHandler>>();

  /** Subscribe to live message rows for one conversation. Returns an unsubscribe. */
  subscribe(conversationId: string, cb: MessageHandler): () => void {
    let set = this.subs.get(conversationId);
    if (!set) {
      set = new Set();
      this.subs.set(conversationId, set);
    }
    set.add(cb);
    return () => {
      const current = this.subs.get(conversationId);
      if (!current) return;
      current.delete(cb);
      // Drop the empty subject so the map doesn't leak a Set per closed thread.
      if (current.size === 0) this.subs.delete(conversationId);
    };
  }

  /** Deliver one wire-shaped message row to every live subscriber of its conversation. */
  publish(conversationId: string, row: SerializedMessage): void {
    const set = this.subs.get(conversationId);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(row);
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

export const conversationBus = new ConversationBus();
