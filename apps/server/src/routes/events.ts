import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { documents, events } from '../db/schema.ts';
import type { AuthContext } from '../middleware/auth.ts';
import { requireUserOrToken } from '../middleware/bearer.ts';
import { intersectAgentProjects, resolveAgentProjects } from '../lib/agent-projects.ts';
import { getWorkspace, type ScopeContext } from '../middleware/scope.ts';
import { eventBus, type BusEvent } from '../lib/event-bus.ts';
import type { EventKind } from '../lib/events.ts';
import { HTTPError } from '../lib/http.ts';
import { isAgentEventVisible, type AgentEventContext } from '../lib/agent-event-visibility.ts';

const eventsRoute = new Hono<AuthContext & ScopeContext>();

// resolveWorkspace already ran upstream (wScope chain), so getWorkspace is
// safe inside the handler. requireUserOrToken also already ran upstream.

eventsRoute.get('/', async (c) => {
  const ws = getWorkspace(c);

  // H14: normalize empty `?project=` to undefined the same way parent/run are
  // normalized below. Without this, an agent-bound token sending `?project=`
  // (empty string, common when a client toggles a filter off) hit the
  // allow-list gate with projectId='' and got a confusing 403 — while empty
  // ?parent= / ?run= were silently ignored.
  const projectParam = c.req.query('project');
  const projectId = projectParam && projectParam.trim() ? projectParam.trim() : undefined;
  const kindsParam = c.req.query('kinds');
  // S20: cap to 64 to bound the per-event filter cost. KNOWN_EVENT_KINDS
  // currently lists ~20 values; 64 is a generous ceiling that still rejects
  // a hostile caller sending `?kinds=` with thousands of comma-separated
  // entries to amplify per-event predicate work.
  const KINDS_MAX = 64;
  const kinds = kindsParam
    ? (kindsParam
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean)
        .slice(0, KINDS_MAX) as EventKind[])
    : undefined;
  const parentParam = c.req.query('parent');
  const parentId = parentParam && parentParam.trim() ? parentParam.trim() : undefined;
  const runParam = c.req.query('run');
  const runId = runParam && runParam.trim() ? runParam.trim() : undefined;
  const lastEventId = c.req.header('Last-Event-Id');

  // F3 — agent allow-list enforcement. SSE mounts under wScope only (no
  // pScope), so resolveProject + requireResource never run. We resolve the
  // calling agent's effective allow-list here and narrow both the ?project=
  // gate AND the replay/live filter accordingly. Human PATs and session auth
  // bypass (token === null OR token.agentId === null). Phase 3+ adds per-PAT
  // narrowing once a UI exists for it.
  const token = c.get('token') ?? null;
  let agentAllowList: string[] | null = null; // null === unrestricted
  let agentEventCtx: AgentEventContext = { agentId: null, agentSlug: null };
  if (token?.agentId) {
    const agent = await db.query.documents.findFirst({
      where: eq(documents.id, token.agentId),
    });
    if (!agent || agent.type !== 'agent') {
      throw new HTTPError('FORBIDDEN_RESOURCE', 'agent for this token no longer exists', 403);
    }
    agentEventCtx = { agentId: agent.id, agentSlug: agent.slug };
    const agentProjects = resolveAgentProjects(agent);
    const effective = intersectAgentProjects(agentProjects, token.projectIds ?? null);
    if (!effective.includes('*')) {
      agentAllowList = effective;
      // Explicit ?project= must be in the allow-list — fail closed.
      if (projectId !== undefined && !effective.includes(projectId)) {
        throw new HTTPError(
          'FORBIDDEN_RESOURCE',
          'agent not allow-listed for that project',
          403,
        );
      }
    }
  }

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
        // H3: seq is the canonical replay cursor. nanoid ids aren't
        // insertion-sortable (random URL-safe charset), so the prior
        // composite (createdAt, id) cursor dropped same-ms events whose
        // id lex-sorted BEFORE the anchor. seq is monotonic per insert,
        // so `seq > anchor.seq` orders the tail correctly with no ties.
        //
        // H4: replay PAGINATES with a continuation cursor instead of a
        // single 500-row pre-filter. Narrowed agents on busy workspaces
        // would otherwise silently miss events further down the log when
        // the first batch is dominated by rows outside their visibility.
        let cursorSeq = anchor.seq;
        const PAGE_SIZE = 500;
        // Generous upper bound to avoid pathological infinite-fetch on a
        // broken filter or runaway emit storm. Replay deliberately caps
        // at this many DELIVERED rows; remaining tail is the client's
        // problem (reconcile via REST).
        const MAX_DELIVERED = 2000;
        let delivered = 0;

        outer: while (delivered < MAX_DELIVERED) {
          const rows = await db.query.events.findMany({
            where: and(
              eq(events.workspaceId, ws.id),
              gt(events.seq, cursorSeq),
            ),
            orderBy: (e, { asc }) => [asc(e.seq)],
            limit: PAGE_SIZE,
          });
          if (rows.length === 0) break;

          for (const row of rows) {
            cursorSeq = row.seq;
            if (projectId && row.projectId !== projectId) continue;
            // F3: agent allow-list narrows project-scoped rows.
            if (agentAllowList && row.projectId !== null && !agentAllowList.includes(row.projectId)) {
              continue;
            }
            // H1/H2: workspace-level (projectId=null) events filtered through
            // the subject-based visibility predicate.
            if (
              !isAgentEventVisible(agentEventCtx, {
                kind: row.kind as EventKind,
                projectId: row.projectId,
                documentId: row.documentId,
                payload: row.payload,
              })
            ) {
              continue;
            }
            if (kinds && !kinds.includes(row.kind as EventKind)) continue;
            if (parentId !== undefined) {
              const p = (row.payload as Record<string, unknown> | null)?.parent_id;
              if (p !== parentId) continue;
            }
            if (runId !== undefined) {
              const r = (row.payload as Record<string, unknown> | null)?.run_id;
              if (r !== runId) continue;
            }
            if (stream.aborted) break outer;
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
            delivered += 1;
            if (delivered >= MAX_DELIVERED) break outer;
          }
          if (rows.length < PAGE_SIZE) break;
        }
      }
    }

    // Subscribe to live events. The bus filter mirrors the replay filter so
    // both paths honor `kinds` and `project` query params identically.
    //
    // BUG-006 (shake-out): the consumer awaits a `waiter` promise that the
    // bus handler resolves on push and the abort handler resolves on abort.
    // The previous 100ms-poll wasted ~10 wakeups/sec per open connection on
    // an idle workspace; this gives event-driven latency with zero idle work.
    const queue: BusEvent[] = [];
    let wake!: () => void;
    let waiter = new Promise<void>((r) => {
      wake = r;
    });
    const renewWaiter = () => {
      waiter = new Promise<void>((r) => {
        wake = r;
      });
    };

    const unsub = eventBus.subscribe(
      ws.id,
      {
        kinds: kinds as EventKind[] | undefined,
        projectId,
        parentId,
        runId,
      },
      (e) => {
        // F3: drop project-scoped events outside the agent's allow-list.
        if (
          agentAllowList &&
          e.projectId != null &&
          !agentAllowList.includes(e.projectId)
        ) {
          return;
        }
        // H1/H2: subject-based visibility (see replay loop above).
        if (
          !isAgentEventVisible(agentEventCtx, {
            kind: e.kind,
            projectId: e.projectId ?? null,
            documentId: e.documentId ?? null,
            payload: e.payload,
          })
        ) {
          return;
        }
        queue.push(e);
        wake();
      },
    );

    let aborted = false;
    stream.onAbort(() => {
      aborted = true;
      wake();
    });

    // Heartbeat every 30s. Uses the `ping` event name so clients can ignore
    // it via the EventSource onmessage default handler.
    const heartbeat = setInterval(() => {
      void stream.writeSSE({ event: 'ping', data: '' });
    }, 30_000);

    try {
      while (!aborted && !stream.aborted) {
        while (queue.length > 0) {
          const e = queue.shift()!;
          await stream.writeSSE({
            id: e.id,
            event: e.kind,
            data: JSON.stringify(e),
          });
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
  });
});

export { eventsRoute };
