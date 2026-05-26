import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { events } from '../db/schema.ts';
import type { AuthContext } from '../middleware/auth.ts';
import { requireUserOrToken } from '../middleware/bearer.ts';
import { getWorkspace, type ScopeContext } from '../middleware/scope.ts';
import { eventBus, type BusEvent } from '../lib/event-bus.ts';
import type { EventKind } from '../lib/events.ts';

const eventsRoute = new Hono<AuthContext & ScopeContext>();

// resolveWorkspace already ran upstream (wScope chain), so getWorkspace is
// safe inside the handler. requireUserOrToken also already ran upstream.

eventsRoute.get('/', async (c) => {
  const ws = getWorkspace(c);

  const projectId = c.req.query('project');
  const kindsParam = c.req.query('kinds');
  const kinds = kindsParam
    ? (kindsParam.split(',').map((k) => k.trim()).filter(Boolean) as EventKind[])
    : undefined;
  const parentParam = c.req.query('parent');
  const parentId = parentParam && parentParam.trim() ? parentParam.trim() : undefined;
  const runParam = c.req.query('run');
  const runId = runParam && runParam.trim() ? runParam.trim() : undefined;
  const lastEventId = c.req.header('Last-Event-Id');

  return streamSSE(c, async (stream) => {
    // Replay from the durable event log when Last-Event-Id is present.
    // nanoid is NOT time-sortable, so we look up the anchor row and use its
    // createdAt to slice the tail. If the anchor row no longer exists (purged
    // or unknown), skip replay entirely — the safest behavior is to start
    // fresh on live events; the client can reconcile from REST if needed.
    if (lastEventId) {
      const anchor = await db.query.events.findFirst({
        where: eq(events.id, lastEventId),
      });
      if (anchor) {
        const rows = await db.query.events.findMany({
          where: and(
            eq(events.workspaceId, ws.id),
            gt(events.createdAt, anchor.createdAt),
          ),
          orderBy: (e, { asc }) => [asc(e.createdAt), asc(e.id)],
          limit: 500,
        });
        for (const row of rows) {
          if (projectId && row.projectId !== projectId) continue;
          if (kinds && !kinds.includes(row.kind as EventKind)) continue;
          if (parentId !== undefined) {
            const p = (row.payload as Record<string, unknown> | null)?.parent_id;
            if (p !== parentId) continue;
          }
          if (runId !== undefined) {
            const r = (row.payload as Record<string, unknown> | null)?.run_id;
            if (r !== runId) continue;
          }
          if (stream.aborted) return;
          await stream.writeSSE({
            id: row.id,
            event: row.kind,
            data: JSON.stringify({
              id: row.id,
              workspaceId: row.workspaceId,
              projectId: row.projectId,
              documentId: row.documentId,
              kind: row.kind,
              actor: row.actor,
              payload: row.payload,
              createdAt: row.createdAt instanceof Date
                ? row.createdAt.getTime()
                : row.createdAt,
            }),
          });
        }
      }
    }

    // Subscribe to live events. The bus filter mirrors the replay filter so
    // both paths honor `kinds` and `project` query params identically.
    const queue: BusEvent[] = [];
    const unsub = eventBus.subscribe(
      ws.id,
      {
        kinds: kinds as EventKind[] | undefined,
        projectId,
        parentId,
        runId,
      },
      (e) => {
        queue.push(e);
      },
    );

    let aborted = false;
    stream.onAbort(() => {
      aborted = true;
    });

    // Heartbeat every 30s. Uses the `ping` event name so clients can ignore
    // it via the EventSource onmessage default handler.
    const heartbeat = setInterval(() => {
      void stream.writeSSE({ event: 'ping', data: '' });
    }, 30_000);

    try {
      while (!aborted && !stream.aborted) {
        if (queue.length > 0) {
          const e = queue.shift()!;
          await stream.writeSSE({
            id: e.id,
            event: e.kind,
            data: JSON.stringify(e),
          });
        } else {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    } finally {
      clearInterval(heartbeat);
      unsub();
    }
  });
});

export { eventsRoute };
