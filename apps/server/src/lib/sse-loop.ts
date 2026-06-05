/**
 * Shared event-driven SSE delivery loop.
 *
 * Both the workspace `/events` channel and the dedicated conversation
 * `/conversations/:id/stream` channel run the SAME plumbing: a queue fed by a
 * bus subscription, a waiter promise the bus handler resolves on push and the
 * abort handler resolves on abort (zero idle polling — BUG-006), a 30s `ping`
 * heartbeat, and a finally that clears the interval + unsubscribes. This was
 * duplicated verbatim across the two routes (Cluster-5 /code-review fix #9); it
 * lives here ONCE so a correctness fix to the loop is made + tested in one place.
 *
 * The two routes differ only in (a) what they subscribe to and (b) the SSE frame
 * shape — both injected as callbacks. `subscribe(onRow)` registers a listener and
 * returns an unsubscribe; `toFrame(row)` maps a delivered row to the `writeSSE`
 * argument (the events route uses a per-row `event: kind`, the conversation route
 * a fixed `event: 'message'`).
 */

import type { SSEStreamingApi } from 'hono/streaming';

export interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

/**
 * Run the live-tail loop until the stream aborts. `subscribe` is called once with
 * a push callback and must return an unsubscribe; `toFrame` serializes each
 * delivered row into an SSE frame.
 */
export async function runSseLoop<Row>(
  stream: SSEStreamingApi,
  subscribe: (onRow: (row: Row) => void) => () => void,
  toFrame: (row: Row) => SseFrame,
): Promise<void> {
  const queue: Row[] = [];
  let wake!: () => void;
  let waiter = new Promise<void>((r) => {
    wake = r;
  });
  const renewWaiter = () => {
    waiter = new Promise<void>((r) => {
      wake = r;
    });
  };

  const unsub = subscribe((row) => {
    queue.push(row);
    wake();
  });

  let aborted = false;
  stream.onAbort(() => {
    aborted = true;
    wake();
  });

  // Heartbeat every 30s; `ping` frames carry empty data so clients ignore them
  // via the EventSource default onmessage handler.
  const heartbeat = setInterval(() => {
    void stream.writeSSE({ event: 'ping', data: '' });
  }, 30_000);

  try {
    while (!aborted && !stream.aborted) {
      while (queue.length > 0) {
        const row = queue.shift()!;
        await stream.writeSSE(toFrame(row));
        if (stream.aborted) break;
      }
      if (aborted || stream.aborted) break;
      await waiter;
      renewWaiter();
    }
  } finally {
    clearInterval(heartbeat);
    unsub();
  }
}
