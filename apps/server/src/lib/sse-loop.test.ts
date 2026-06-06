import { test, expect } from 'bun:test';
import { runSseLoop, type SseFrame } from './sse-loop.ts';

// A minimal fake of hono's SSEStreamingApi covering what runSseLoop touches.
function makeFakeStream() {
  const writes: SseFrame[] = [];
  let abortCb: (() => void) | null = null;
  return {
    aborted: false,
    writes,
    onAbort(cb: () => void) {
      abortCb = cb;
    },
    async writeSSE(frame: SseFrame) {
      writes.push(frame);
    },
    // test helper: simulate the client disconnecting
    fireAbort() {
      this.aborted = true;
      abortCb?.();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

test('runSseLoop drains queued rows in order through toFrame, then unsubscribes on abort', async () => {
  const stream = makeFakeStream();
  let unsubscribed = false;
  let push!: (row: { id: string }) => void;

  const loop = runSseLoop<{ id: string }>(
    stream,
    (onRow) => {
      push = onRow;
      return () => {
        unsubscribed = true;
      };
    },
    (row) => ({ id: row.id, event: 'message', data: JSON.stringify(row) }),
  );

  // Push two rows, then abort so the loop terminates. Yield enough microtask
  // turns for the loop to wake from its waiter and drain the queue before abort.
  push({ id: 'a' });
  push({ id: 'b' });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  stream.fireAbort();
  await loop;

  const dataFrames = stream.writes.filter((w: SseFrame) => w.event === 'message');
  expect(dataFrames.map((w: SseFrame) => w.id)).toEqual(['a', 'b']);
  // toFrame was applied (not a raw row).
  expect(dataFrames[0]?.data).toBe(JSON.stringify({ id: 'a' }));
  // The finally ran: unsub called exactly once.
  expect(unsubscribed).toBe(true);
});

test('runSseLoop terminates immediately if already aborted (no hang)', async () => {
  const stream = makeFakeStream();
  stream.aborted = true;
  let unsubscribed = false;

  await runSseLoop<{ id: string }>(
    stream,
    () => () => {
      unsubscribed = true;
    },
    (row) => ({ data: JSON.stringify(row) }),
  );

  // No data frames written; unsub still ran via finally.
  expect(stream.writes.filter((w: SseFrame) => w.event === 'message')).toHaveLength(0);
  expect(unsubscribed).toBe(true);
});
