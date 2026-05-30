# Phase 3 Sub-phase E — Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build every web UI surface a human touches in Phase 3 — live runs status, approval buttons, provider/reactor banners, Cmd-K run controls, and the `[[` wiki-link picker — on top of the server APIs D shipped.

**Architecture:** A single reusable `useEventStream()` hook wraps the native browser `EventSource` and, on each server event, calls `queryClient.invalidateQueries(...)`. **SSE teaches react-query *when* data changed; it does not become a second source of truth.** react-query remains the cache/store; every UI surface reads through existing or new react-query hooks. No parallel client state model, no event store, no websockets, no sidecars.

```
Server Event  →  useEventStream  →  queryClient.invalidateQueries()  →  existing react-query refetches fresh data
```

**Tech Stack:** React + Vite + TanStack Router + @tanstack/react-query + native `EventSource`. Tests: Vitest (`cd apps/web && bun run test`), Playwright for e2e (`bun run e2e`).

---

## Reconciliation table (ground-truthed against live source at HEAD `cf5b2f6`, 2026-05-30)

The mega-plan outline (`2026-05-27-phase-3-agent-runner.md` §"Sub-phase E") drifted from what D actually shipped. This plan supersedes it. Verified facts:

| Concern | Outline said | **Reality (verified)** |
|---|---|---|
| SSE mount path | (unspecified) | `GET /api/v1/w/:wslug/events` — **workspace-scoped**, not project. |
| `?agent=` filter | `?agent=<doc_id>` | **`?agent=<slug>`** — matches `payload.agent` (events.ts:165). |
| `?table=` filter | (unspecified) | `?table=<tableId>` — matches `payload.table_id` (events.ts:170). |
| SSE filters combine | (unspecified) | AND-combined. `?project ?kinds ?parent ?run ?agent ?table`. |
| SSE message shape | (unspecified) | `{ id: <nanoid>, event: <kind>, data: JSON.stringify({id,workspaceId,projectId,documentId,kind,actor,payload,createdAt}) }`. Heartbeat `event: 'ping'` every 30s. `id` drives `Last-Event-Id` replay. |
| List runs response | `{data: AgentRun[]}` | `jsonOk(c, rows)` = **bare array**. The client unwraps `{data}` only when it's the sole key; a bare array passes straight through. |
| List runs path | (unspecified) | `GET /api/v1/w/:wslug/p/:pslug/runs?status=&agent=&since=` (project-scoped). |
| Single run path | (unspecified) | `GET /api/v1/w/:wslug/runs/:runId` (workspace-scoped). |
| Create run | `POST /runs` | `POST /api/v1/w/:wslug/runs` body `{agent_slug, parent_slug, input?}` → `{run_id, status:'planning'}` (201). |
| Cancel/retry | (unspecified) | `POST /api/v1/w/:wslug/runs/:runId/cancel` → `{run_id, status}`; `.../retry` → `{run_id, status:'planning'}` (201). |
| provider-health | `{anthropic:{status,consecutiveFailures},...}` | Confirmed. `GET /api/v1/w/:wslug/provider-health` → `{anthropic,openai,openrouter,ollama}` each `{status:'healthy'|'degraded', consecutiveFailures:number}`. |
| `agent.run.*` kinds | (unspecified) | Exactly 6: `started, awaiting_approval, running, completed, failed, rejected`. |
| Agent/trigger slideover Runs tab | "add a Runs tab" | `workspace-document-slideover.tsx` **already declares** `'runs'` in its tab union (line 37). E-3 fills it; does not add it. |
| Cmd-K registration | (unspecified) | `command-palette.tsx` uses inline `matches({label}, query)` + `<CommandItem onSelect>`. Follow that, not the `command-registry.ts` provider shape. |
| Banner mount | "main shell" | `apps/web/src/routes/__root.tsx`, above `<Outlet />` inside the `!isAuthRoute` branch. |
| Wiki-link picker | "wire WikiLinkPicker into Milkdown" | `body-editor.tsx` already has slash detection (lines 73-122) + a `SlashMenu`; E-8 adds `[[` detection that opens `WikiLinkPicker` and inserts `[[<slug>]]`. |

**Auth note (load-bearing for E-1):** the API client uses `credentials: 'include'` (cookie session). Native `EventSource` sends same-origin cookies automatically — **no token threading, no Authorization header** (EventSource can't set headers anyway). Paths are same-origin relative.

---

## SSE-client design decision (LOCKED 2026-05-30 — see `memory/DECISIONS.md`)

**Option A, minimal.** Stefan's narrow success definition:

- **E-1 = `useEventStream()` and nothing else.** `EventSource` + cleanup + reconnect (lean on native auto-reconnect + `Last-Event-Id`) + filter params. One file, one responsibility, no UI.
- **E-2 = consume it for exactly five event classes** — run state, approval state, provider degraded/recovered, reactor halted/recovered. Each handler does **nothing but `invalidateQueries`**.
- **E-3+ = wire into existing surfaces** via cache invalidation only. Never a second source of truth.

What we explicitly do NOT build: websocket upgrade, a client event store / event-sourcing, hand-rolled backoff, a multiplexed connection singleton (one `EventSource` per subscribing surface is fine for v1 volume), document locking (still deferred — last-write-wins via `updated_at` holds).

---

## File Structure

**New files:**
- `apps/web/src/lib/api/event-stream.ts` — `useEventStream()` hook (E-1). The ONLY new realtime primitive.
- `apps/web/src/lib/api/event-stream.test.tsx` — E-1 tests.
- `apps/web/src/lib/api/runs.ts` — `useRuns/useRun/useCreateRun/useCancelRun/useRetryRun` react-query hooks + `AgentRunDoc` type (E-2).
- `apps/web/src/lib/api/runs.test.tsx` — E-2 tests.
- `apps/web/src/lib/api/provider-health.ts` — `useProviderHealth(wslug)` + `useReactorHealth()` SSE-merged state (E-2b).
- `apps/web/src/lib/api/provider-health.test.tsx` — E-2b tests.
- `apps/web/src/components/runs/runs-link-tile.tsx` (+ `.test.tsx`) — count-by-status tile (E-3).
- `apps/web/src/components/cmd-k/run-agent-command.tsx` + `approve-pending-command.tsx` (+ tests) — E-5.
- `apps/web/src/components/shell/provider-health-banner.tsx` + `reactor-halt-banner.tsx` (+ tests) — E-7.

**Modified files:**
- `apps/web/src/components/slideover/workspace-document-slideover.tsx` — render `RunsLinkTile` in the existing `'runs'` tab (E-3).
- `apps/web/src/components/command-palette.tsx` — register the two new commands (E-5).
- `apps/web/src/components/comments/approval-buttons.tsx` — query linked run + render live state (E-6).
- `apps/web/src/components/shell/agent-slideover.tsx` (or wherever the agent fields render) — inline "provider offline" notice (E-7).
- `apps/web/src/components/slideover/workspace-settings.tsx` — honor `?tab=ai&provider=<p>` (E-7).
- `apps/web/src/components/slideover/body-editor.tsx` — `[[` → `WikiLinkPicker` (E-8).
- `apps/web/src/routes/__root.tsx` — mount the two banners (E-7).

---

## Threat model

E inherits mitigations 1–66 (B 1-22 · C 23-47 · C.3 48-53 · D 54-63 · D-9 64-66). **E adds no new server endpoint** — D shipped them all — so no new mitigations. E is client rendering + consuming already-gated endpoints:

- The SSE stream's allow-list + per-bearer subject-visibility filters (`agent-event-visibility.ts`, mitigations F3/visibility) already gate what a connection sees server-side. E's client just consumes; it does NOT re-filter or bypass.
- E-5's "Run agent" and E-6's approve/reject POST through D's already-gated endpoints (the autonomy gate, mit 54, fires only for agent-bound bearers — a human/session caller from the UI is allowed by design).
- E opens `EventSource` connections with cookie auth (same gate as every other request). No secret material crosses to the client beyond what the gated endpoints already return.

If any task discovers it needs a NEW server endpoint (it should not), STOP and invoke `netdust-core:threat-modeling` to extend mitigations 67+ before writing it.

---

### Task E-1: `useEventStream()` — the one realtime primitive

**Files:**
- Create: `apps/web/src/lib/api/event-stream.ts`
- Test: `apps/web/src/lib/api/event-stream.test.tsx`

**Scope:** A hook that opens a single `EventSource` to `GET /api/v1/w/:wslug/events` with the given filter params, invokes `onEvent(parsed)` for each non-`ping` message, and tears the connection down on unmount or param change. Reconnect is native `EventSource` behavior; `Last-Event-Id` replay is server-side. **No UI, no react-query — pure transport.** Consumers (E-2+) supply the `invalidateQueries` callback.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/lib/api/event-stream.test.tsx
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEventStream, type StreamedEvent } from './event-stream.ts';

// Minimal EventSource mock: records constructed URL, lets the test emit messages.
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  withCredentials: boolean;
  onmessage: ((e: MessageEvent) => void) | null = null;
  listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  closed = false;
  constructor(url: string, init?: EventSourceInit) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }
  removeEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== fn));
  }
  emit(type: string, data: string) {
    const ev = { data } as MessageEvent;
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
    if (type === 'message') this.onmessage?.(ev);
  }
  close() { this.closed = true; }
}

beforeEach(() => {
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
});
afterEach(() => vi.unstubAllGlobals());

describe('useEventStream', () => {
  test('opens an EventSource to the workspace events path with cookie credentials + filters', () => {
    renderHook(() => useEventStream('acme', { agent: 'reply-bot', kinds: ['agent.run.running'] }, vi.fn()));
    expect(MockEventSource.instances).toHaveLength(1);
    const es = MockEventSource.instances[0]!;
    expect(es.url).toBe('/api/v1/w/acme/events?agent=reply-bot&kinds=agent.run.running');
    expect(es.withCredentials).toBe(true);
  });

  test('invokes onEvent with parsed event for a data message, skips ping', () => {
    const onEvent = vi.fn<(e: StreamedEvent) => void>();
    renderHook(() => useEventStream('acme', {}, onEvent));
    const es = MockEventSource.instances[0]!;
    act(() => es.emit('ping', ''));
    expect(onEvent).not.toHaveBeenCalled();
    act(() =>
      es.emit(
        'message',
        JSON.stringify({ id: 'e1', kind: 'agent.run.running', payload: { agent: 'reply-bot' } }),
      ),
    );
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'e1', kind: 'agent.run.running' }),
    );
  });

  test('closes the EventSource on unmount', () => {
    const { unmount } = renderHook(() => useEventStream('acme', {}, vi.fn()));
    const es = MockEventSource.instances[0]!;
    unmount();
    expect(es.closed).toBe(true);
  });

  test('does not open a stream when wslug is empty', () => {
    renderHook(() => useEventStream('', {}, vi.fn()));
    expect(MockEventSource.instances).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun run test src/lib/api/event-stream.test.tsx`
Expected: FAIL — `Cannot find module './event-stream.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/lib/api/event-stream.ts
import { useEffect, useRef } from 'react';

/** Parsed SSE payload. The server sends `data: JSON.stringify({...event row...})`. */
export interface StreamedEvent {
  id: string;
  workspaceId?: string;
  projectId?: string | null;
  documentId?: string | null;
  kind: string;
  actor?: string | null;
  payload?: unknown;
  createdAt?: number;
}

export interface EventStreamFilters {
  project?: string;
  parent?: string;
  run?: string;
  agent?: string; // agent SLUG (server matches payload.agent)
  table?: string; // runs table id (server matches payload.table_id)
  kinds?: string[];
}

function buildQuery(filters: EventStreamFilters): string {
  const sp = new URLSearchParams();
  if (filters.project) sp.set('project', filters.project);
  if (filters.parent) sp.set('parent', filters.parent);
  if (filters.run) sp.set('run', filters.run);
  if (filters.agent) sp.set('agent', filters.agent);
  if (filters.table) sp.set('table', filters.table);
  if (filters.kinds && filters.kinds.length > 0) sp.set('kinds', filters.kinds.join(','));
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

/**
 * Open one EventSource to the workspace event stream and call `onEvent` for
 * each non-ping message. SSE TEACHES react-query WHEN data changed — consumers
 * pass an onEvent that calls queryClient.invalidateQueries(...). This hook owns
 * NO state and is NOT a source of truth.
 *
 * Reconnect is native EventSource behavior; the server supports Last-Event-Id
 * replay, so no hand-rolled backoff. Auth is the same-origin session cookie
 * (withCredentials), matching the rest of the API client.
 */
export function useEventStream(
  wslug: string,
  filters: EventStreamFilters,
  onEvent: (event: StreamedEvent) => void,
): void {
  // Keep the latest onEvent without re-opening the stream when it changes.
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  // Serialize filters so the effect only re-runs on an actual filter change.
  const query = buildQuery(filters);

  useEffect(() => {
    if (!wslug) return;
    const es = new EventSource(`/api/v1/w/${wslug}/events${query}`, { withCredentials: true });

    const handle = (e: MessageEvent) => {
      if (!e.data) return; // ping heartbeats carry empty data
      try {
        onEventRef.current(JSON.parse(e.data) as StreamedEvent);
      } catch {
        // Malformed frame — ignore; the next invalidate will re-sync anyway.
      }
    };

    // The server sets `event: <kind>` on each SSE frame (Hono streamSSE), so
    // the browser routes named events to addEventListener(kind), NOT to
    // 'message'. We therefore attach one listener per requested kind. CONTRACT:
    // every consumer MUST pass an explicit `kinds` array — there is no
    // unfiltered firehose by design. The 'message' listener is a fallback for
    // any unnamed frames. (See the E-1 ground-truth note; verify against
    // routes/events.ts before finalizing.)
    es.addEventListener('message', handle);
    const kinds = filters.kinds ?? [];
    for (const k of kinds) es.addEventListener(k, handle);

    return () => {
      es.removeEventListener('message', handle);
      for (const k of kinds) es.removeEventListener(k, handle);
      es.close();
    };
    // query already encodes every filter field that matters for the connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wslug, query]);
}
```

> **⚠️ E-1 implementer ground-truth note (Step 2.5):** Before finalizing, OPEN `apps/server/src/routes/events.ts` lines 174-189 + 278-282 and confirm whether `streamSSE` sets a NAMED event (`event: row.kind`) or emits unnamed `message` frames. Hono's `streamSSE` writes the `event:` field when the callback provides `event`. The server DOES set `event: row.kind`. **Consequence:** browser `EventSource` routes a named event ONLY to `addEventListener(kind, ...)`, NOT to `'message'`. So a consumer that filters by `kinds` will receive them (we attach per-kind listeners above); a consumer with NO `kinds` filter will NOT receive named events on `'message'`. **Therefore: every E consumer (E-2/E-3/E-6/E-7) MUST pass an explicit `kinds` array.** This is by-design (we never want an unfiltered firehose). The test above asserts the per-kind path; ADD a test that a named-event emit (`es.emit('agent.run.running', ...)`) reaches `onEvent` when `kinds: ['agent.run.running']` was passed, and that it does NOT when kinds is empty. Adjust the implementation comment to state this contract crisply once verified.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && bun run test src/lib/api/event-stream.test.tsx`
Expected: PASS (4 tests, plus the named-event test you added in Step 3's ground-truth note).

- [ ] **Step 5: Typecheck + commit**

```bash
cd apps/web && bunx tsc --noEmit
git add apps/web/src/lib/api/event-stream.ts apps/web/src/lib/api/event-stream.test.tsx
git commit -m "phase-3: useEventStream — single EventSource → onEvent (E-1)"
```

---

### Task E-2: `lib/api/runs.ts` — run hooks, SSE-invalidated

**Files:**
- Create: `apps/web/src/lib/api/runs.ts`
- Test: `apps/web/src/lib/api/runs.test.tsx`

**Scope:** react-query hooks for the D-1 run verbs + an `AgentRunDoc` type. `useRuns(wslug, pslug, filter)` (list), `useRun(wslug, runId)` (single), `useCreateRun(wslug)`, `useCancelRun(wslug)`, `useRetryRun(wslug)`. The list/single are plain queries; create/cancel/retry are mutations that invalidate the runs list + the affected run on settle. **A separate `useRunsLiveSync(wslug, filter)` hook wires `useEventStream` → invalidate the runs queries** for the 6 `agent.run.*` kinds. Optimistic UI on cancel (flip to a pending state) is optional polish; the spec only requires invalidation correctness — keep create/retry non-optimistic (the server assigns the id).

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/lib/api/runs.test.tsx
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, act, waitFor } from '@testing-library/react';
import React from 'react';
import { useRuns, useCreateRun, useCancelRun, runsKeys } from './runs.ts';

function wrapperOf(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (url, init) => {
      const u = String(url);
      if (init?.method === 'POST' && u.endsWith('/runs')) {
        return new Response(JSON.stringify({ data: { run_id: 'r1', status: 'planning' } }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (init?.method === 'POST' && u.includes('/cancel')) {
        return new Response(JSON.stringify({ data: { run_id: 'r1', status: 'failed' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // list: server returns a BARE array via jsonOk; the client passes it through.
      return new Response(JSON.stringify([{ id: 'r1', slug: 'run-1', type: 'agent_run' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('runs hooks', () => {
  test('useRuns fetches the project-scoped runs list and unwraps to an array', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useRuns('acme', 'web', { status: 'running' }), {
      wrapper: wrapperOf(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{ id: 'r1', slug: 'run-1', type: 'agent_run' }]);
    const call = (fetch as unknown as vi.Mock).mock.calls.find((c) => String(c[0]).includes('/runs'));
    expect(String(call![0])).toBe('/api/v1/w/acme/p/web/runs?status=running');
  });

  test('useCreateRun POSTs agent_slug/parent_slug/input and returns {run_id,status}', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useCreateRun('acme'), { wrapper: wrapperOf(qc) });
    let resp: { run_id: string; status: string } | undefined;
    await act(async () => {
      resp = await result.current.mutateAsync({ agent_slug: 'bot', parent_slug: 'task-1' });
    });
    expect(resp).toEqual({ run_id: 'r1', status: 'planning' });
  });

  test('useCancelRun POSTs to the cancel path', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useCancelRun('acme'), { wrapper: wrapperOf(qc) });
    await act(async () => {
      await result.current.mutateAsync({ runId: 'r1' });
    });
    const call = (fetch as unknown as vi.Mock).mock.calls.find((c) => String(c[0]).includes('/cancel'));
    expect(String(call![0])).toBe('/api/v1/w/acme/runs/r1/cancel');
  });

  test('runsKeys.list is project-scoped + filter-keyed', () => {
    expect(runsKeys.list('acme', 'web', { status: 'running' })).toEqual([
      'runs', 'acme', 'web', 'list', { status: 'running' },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun run test src/lib/api/runs.test.tsx`
Expected: FAIL — `Cannot find module './runs.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/lib/api/runs.ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client, type ApiError } from './client.ts';
import { useEventStream } from './event-stream.ts';

/** A run is a `documents` row of type 'agent_run'. We only type what the UI reads. */
export interface AgentRunDoc {
  id: string;
  slug: string;
  type: 'agent_run';
  title: string;
  status: string;
  frontmatter: {
    status?: string;
    agent_slug?: string;
    parent_id?: string;
    error_reason?: string | null;
    [k: string]: unknown;
  };
  createdAt: string;
  updatedAt: string;
}

export interface RunsFilter {
  status?: string;
  agent?: string; // slug
  since?: string; // ISO
}

export interface CreateRunVars {
  agent_slug: string;
  parent_slug: string;
  input?: string;
}

export interface RunMutationResult {
  run_id: string;
  status: string;
}

export const runsKeys = {
  all: ['runs'] as const,
  list: (wslug: string, pslug: string, filter: RunsFilter = {}) =>
    [...runsKeys.all, wslug, pslug, 'list', filter] as const,
  detail: (wslug: string, runId: string) =>
    [...runsKeys.all, wslug, 'detail', runId] as const,
};

function toSearch(filter: RunsFilter): string {
  const sp = new URLSearchParams();
  if (filter.status) sp.set('status', filter.status);
  if (filter.agent) sp.set('agent', filter.agent);
  if (filter.since) sp.set('since', filter.since);
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

export function useRuns(wslug: string, pslug: string, filter: RunsFilter = {}) {
  return useQuery({
    queryKey: runsKeys.list(wslug, pslug, filter),
    queryFn: () =>
      client.get<AgentRunDoc[]>(`/api/v1/w/${wslug}/p/${pslug}/runs${toSearch(filter)}`),
    staleTime: 30_000,
    enabled: !!wslug && !!pslug,
  });
}

export function useRun(wslug: string, runId: string | undefined) {
  return useQuery({
    queryKey: runsKeys.detail(wslug, runId ?? ''),
    queryFn: () => client.get<AgentRunDoc>(`/api/v1/w/${wslug}/runs/${runId}`),
    staleTime: 10_000,
    enabled: !!wslug && !!runId,
  });
}

export function useCreateRun(wslug: string) {
  const qc = useQueryClient();
  return useMutation<RunMutationResult, ApiError, CreateRunVars>({
    mutationFn: (vars) => client.post<RunMutationResult>(`/api/v1/w/${wslug}/runs`, vars),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: runsKeys.all });
    },
  });
}

export function useCancelRun(wslug: string) {
  const qc = useQueryClient();
  return useMutation<RunMutationResult, ApiError, { runId: string }>({
    mutationFn: ({ runId }) => client.post<RunMutationResult>(`/api/v1/w/${wslug}/runs/${runId}/cancel`),
    onSettled: (_d, _e, vars) => {
      qc.invalidateQueries({ queryKey: runsKeys.all });
      qc.invalidateQueries({ queryKey: runsKeys.detail(wslug, vars.runId) });
    },
  });
}

export function useRetryRun(wslug: string) {
  const qc = useQueryClient();
  return useMutation<RunMutationResult, ApiError, { runId: string }>({
    mutationFn: ({ runId }) => client.post<RunMutationResult>(`/api/v1/w/${wslug}/runs/${runId}/retry`),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: runsKeys.all });
    },
  });
}

const RUN_KINDS = [
  'agent.run.started',
  'agent.run.awaiting_approval',
  'agent.run.running',
  'agent.run.completed',
  'agent.run.failed',
  'agent.run.rejected',
] as const;

/**
 * Subscribe to run-lifecycle events for one filter and invalidate the runs
 * queries on receipt. THIS is the whole realtime story for runs: SSE only
 * tells react-query "something changed, refetch". Mount once near a runs view.
 */
export function useRunsLiveSync(
  wslug: string,
  filter: { agent?: string; table?: string; run?: string } = {},
) {
  const qc = useQueryClient();
  useEventStream(wslug, { ...filter, kinds: [...RUN_KINDS] }, () => {
    qc.invalidateQueries({ queryKey: runsKeys.all });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && bun run test src/lib/api/runs.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
cd apps/web && bunx tsc --noEmit
git add apps/web/src/lib/api/runs.ts apps/web/src/lib/api/runs.test.tsx
git commit -m "phase-3: runs react-query hooks + useRunsLiveSync (E-2)"
```

---

### Task E-2b: `useProviderHealth` + `useReactorHealth`

**Files:**
- Create: `apps/web/src/lib/api/provider-health.ts`
- Test: `apps/web/src/lib/api/provider-health.test.tsx`

**Scope:** `useProviderHealth(wslug)` — one-shot `GET /provider-health` + a live-sync that invalidates it on `workspace.provider.degraded|recovered`. `useReactorHealth(wslug)` — derives a "halted" boolean from the latest `reactor.halted`/`reactor.recovered` events. Reactor health has no GET endpoint (it's broadcast-only system events, mitigation 53), so `useReactorHealth` holds the last-seen state in a tiny react-query cache entry that SSE updates via `setQueryData` — this is the ONE place SSE writes data directly, because there's no fetch to invalidate. Keep it minimal: a boolean + the error-class string.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/lib/api/provider-health.test.tsx
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { useProviderHealth, providerHealthKeys } from './provider-health.ts';

function wrapperOf(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal('EventSource', class {
    addEventListener() {}
    removeEventListener() {}
    close() {}
  } as unknown as typeof EventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({
          data: {
            anthropic: { status: 'degraded', consecutiveFailures: 3 },
            openai: { status: 'healthy', consecutiveFailures: 0 },
            openrouter: { status: 'healthy', consecutiveFailures: 0 },
            ollama: { status: 'healthy', consecutiveFailures: 0 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('useProviderHealth', () => {
  test('fetches provider health and exposes per-provider status', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useProviderHealth('acme'), { wrapper: wrapperOf(qc) });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data!.anthropic.status).toBe('degraded');
    expect(result.current.data!.anthropic.consecutiveFailures).toBe(3);
  });

  test('key factory is workspace-scoped', () => {
    expect(providerHealthKeys.detail('acme')).toEqual(['provider-health', 'acme']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun run test src/lib/api/provider-health.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// apps/web/src/lib/api/provider-health.ts
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from './client.ts';
import { useEventStream, type StreamedEvent } from './event-stream.ts';

export type ProviderStatus = 'healthy' | 'degraded';
export interface ProviderEntry {
  status: ProviderStatus;
  consecutiveFailures: number;
}
export interface ProviderHealth {
  anthropic: ProviderEntry;
  openai: ProviderEntry;
  openrouter: ProviderEntry;
  ollama: ProviderEntry;
}

export const providerHealthKeys = {
  detail: (wslug: string) => ['provider-health', wslug] as const,
};

export function useProviderHealth(wslug: string) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: providerHealthKeys.detail(wslug),
    queryFn: () => client.get<ProviderHealth>(`/api/v1/w/${wslug}/provider-health`),
    staleTime: 60_000,
    enabled: !!wslug,
  });
  // SSE → invalidate (re-fetch fresh truth from the endpoint).
  useEventStream(
    wslug,
    { kinds: ['workspace.provider.degraded', 'workspace.provider.recovered'] },
    () => qc.invalidateQueries({ queryKey: providerHealthKeys.detail(wslug) }),
  );
  return query;
}

export interface ReactorHealth {
  halted: boolean;
  errorClass: string | null;
}
export const reactorHealthKeys = {
  detail: (wslug: string) => ['reactor-health', wslug] as const,
};

/**
 * Reactor health has NO GET endpoint — it's broadcast-only system events
 * (mitigation 53: error CLASS name only, no tenant data). So SSE is the only
 * source; we hold the last-seen state in a react-query cache entry that SSE
 * writes via setQueryData. This is the ONE place SSE writes data directly,
 * justified because there's no fetch to invalidate.
 */
export function useReactorHealth(wslug: string): ReactorHealth {
  const qc = useQueryClient();
  const query = useQuery<ReactorHealth>({
    queryKey: reactorHealthKeys.detail(wslug),
    queryFn: () => ({ halted: false, errorClass: null }),
    staleTime: Infinity,
    enabled: !!wslug,
  });
  useEventStream(
    wslug,
    { kinds: ['reactor.halted', 'reactor.recovered'] },
    (event: StreamedEvent) => {
      const halted = event.kind === 'reactor.halted';
      const payload = (event.payload ?? {}) as { error_class?: string };
      qc.setQueryData<ReactorHealth>(reactorHealthKeys.detail(wslug), {
        halted,
        errorClass: halted ? payload.error_class ?? 'unknown' : null,
      });
    },
  );
  return query.data ?? { halted: false, errorClass: null };
}
```

> **⚠️ E-2b ground-truth note (Step 2.5):** Confirm the `reactor.halted` payload field name for the error class. Read where `reactor.halted` is emitted (`grep -rn "reactor.halted" apps/server/src`) and verify the payload key (the plan assumes `error_class`; C.3 mitigation 53 says "error CLASS name only"). Adjust `payload.error_class` to the real key. Also confirm `workspace.provider.degraded` carries a `provider` key if E-7's banner wants to name the provider (it re-fetches `provider-health` anyway, so this is optional).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && bun run test src/lib/api/provider-health.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
cd apps/web && bunx tsc --noEmit
git add apps/web/src/lib/api/provider-health.ts apps/web/src/lib/api/provider-health.test.tsx
git commit -m "phase-3: useProviderHealth + useReactorHealth, SSE-synced (E-2b)"
```

---

### Task E-3: Runs link tile on the agent/trigger slideover Runs tab

**Files:**
- Create: `apps/web/src/components/runs/runs-link-tile.tsx` + `.test.tsx`
- Modify: `apps/web/src/components/slideover/workspace-document-slideover.tsx` (render the tile in the existing `'runs'` tab)

**Scope:** A tile that shows run counts by status for one agent (via `useRuns` filtered by `agent=<slug>` across... actually runs are project-scoped; for an agent slideover the tile lists the agent's recent runs workspace-wide is not available as a single endpoint — so the tile takes a `pslug` OR renders "Open runs table →" links per project the agent touches). **Reconciliation decision:** keep E-3 simple — the tile shows the agent's runs *for the current project context if present*, plus a "Open Runs table →" link. It mounts `useRunsLiveSync(wslug, { agent: slug })` so counts refresh live. The agent slideover is workspace-scoped (no single project), so the tile primarily renders the live "Open Runs table" navigation + a count badge sourced from the most relevant project. Verify the exact navigation target in the ground-truth note.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/runs/runs-link-tile.test.tsx
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { RunsLinkTile } from './runs-link-tile.tsx';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.stubGlobal('EventSource', class { addEventListener() {} removeEventListener() {} close() {} } as unknown as typeof EventSource);
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () =>
    new Response(JSON.stringify([
      { id: 'r1', slug: 'run-1', type: 'agent_run', frontmatter: { status: 'running' } },
      { id: 'r2', slug: 'run-2', type: 'agent_run', frontmatter: { status: 'completed' } },
    ]), { status: 200, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => vi.unstubAllGlobals());

describe('RunsLinkTile', () => {
  test('renders a Runs heading and an Open Runs table link', async () => {
    wrap(<RunsLinkTile wslug="acme" pslug="web" agentSlug="bot" />);
    expect(await screen.findByText(/runs/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open runs table/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun run test src/components/runs/runs-link-tile.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```tsx
// apps/web/src/components/runs/runs-link-tile.tsx
import { Link } from '@tanstack/react-router';
import { useRuns, useRunsLiveSync } from '../../lib/api/runs.ts';

interface RunsLinkTileProps {
  wslug: string;
  pslug: string;
  agentSlug: string;
}

const STATUS_ORDER = ['running', 'awaiting_approval', 'planning', 'completed', 'failed', 'rejected'] as const;

export function RunsLinkTile({ wslug, pslug, agentSlug }: RunsLinkTileProps) {
  useRunsLiveSync(wslug, { agent: agentSlug });
  const runsQ = useRuns(wslug, pslug, { agent: agentSlug });
  const runs = runsQ.data ?? [];

  const counts = new Map<string, number>();
  for (const r of runs) {
    const s = (r.frontmatter.status as string | undefined) ?? r.status ?? 'unknown';
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }

  return (
    <div className="rounded-md border border-border-light p-3">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-medium text-fg-2">Runs</h4>
        <Link
          to="/w/$wslug/p/$pslug/tables/$tslug"
          params={{ wslug, pslug, tslug: 'runs' }}
          search={{ agent: agentSlug } as never}
          className="text-xs text-accent hover:underline"
        >
          Open Runs table →
        </Link>
      </div>
      {runs.length === 0 ? (
        <p className="text-xs text-fg-3">No runs yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-2 text-xs">
          {STATUS_ORDER.filter((s) => counts.has(s)).map((s) => (
            <li key={s} className="rounded bg-fg-1/5 px-2 py-0.5 text-fg-2">
              {s}: {counts.get(s)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

> **⚠️ E-3 ground-truth note (Step 2.5):** (1) Verify the runs table route path + params by reading the TanStack route tree (`grep -rn "tables/\$tslug\|tslug" apps/web/src/routes`). The `Link to`/`params`/`search` above is a guess — match the real route. (2) Open `workspace-document-slideover.tsx` and confirm the `'runs'` tab branch exists (line ~37 declares the union member); render `<RunsLinkTile>` there. The agent slideover is workspace-scoped — decide what `pslug` to pass (the agent's first allow-listed project, or render the tile per-project). If a single agent has many projects, the simplest v1 is: render the "Open Runs table →" link without a project-specific count, OR pass the project the slideover was opened from if that context exists. Lock this when you read the slideover's available props.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && bun run test src/components/runs/runs-link-tile.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire into the slideover + commit**

Modify `workspace-document-slideover.tsx` to render `<RunsLinkTile>` in the `'runs'` tab branch for `type === 'agent'`. Re-run the slideover's existing tests to confirm no regression.

```bash
cd apps/web && bun run test src/components/slideover/workspace-document-slideover.test.tsx && bunx tsc --noEmit
git add apps/web/src/components/runs/ apps/web/src/components/slideover/workspace-document-slideover.tsx
git commit -m "phase-3: runs link tile on agent slideover, live via SSE (E-3)"
```

---

### Task E-4: Runs table renders via existing TableView (Playwright smoke)

**Files:**
- Create: `apps/web/tests/e2e/phase-3-runs-table.spec.ts`

**Scope:** No new render code — the runs table is a lazy-seeded `tables` row (`slug='runs'`, created by C-6 `ensureRunsTable`) and renders through the existing `TableView`. E-4 is a Playwright smoke: navigate to a project, open the runs table, see the 3 lazy-seeded saved views in the rail. This is a `test.skip` unless a dev server + seed is available; gate it like F-2's real-key test.

- [ ] **Step 1: Write the Playwright smoke (skipped without a running app)**

```ts
// apps/web/tests/e2e/phase-3-runs-table.spec.ts
import { test, expect } from '@playwright/test';

// Smoke: the runs table renders through the existing TableView. Lazy-seeded on
// first access (C-6 ensureRunsTable), so the test navigates and asserts the
// table + its 3 default views appear. Requires a seeded dev server.
test.skip(!process.env.FOLIO_E2E_BASE_URL, 'set FOLIO_E2E_BASE_URL to run');

test('runs table renders with its lazy-seeded views', async ({ page }) => {
  await page.goto(`${process.env.FOLIO_E2E_BASE_URL}/`);
  // Navigate to a project's runs table. Selector specifics depend on the seed;
  // assert the table grid and the runs views in the rail are present.
  await page.getByRole('link', { name: /runs/i }).first().click();
  await expect(page.getByTestId('table-view')).toBeVisible();
});
```

> **⚠️ E-4 ground-truth note (Step 2.5):** Read `apps/web/playwright.config.ts` (if present) for the base-URL convention + existing e2e patterns (Phase 2.5 shipped a Playwright spec — mirror its auth/setup). Confirm the `data-testid` on `TableView` (the recon found `data-testid="table-view"` is NOT confirmed — verify or add one). If no Playwright harness exists yet on this branch, E-4 may be deferred to F-2's e2e setup; note that and move E-4's assertion into the F manual-QA doc instead. Don't invent a harness here.

- [ ] **Step 2: Commit**

```bash
git add apps/web/tests/e2e/phase-3-runs-table.spec.ts
git commit -m "phase-3: runs-table Playwright smoke (E-4)"
```

---

### Task E-5: Cmd-K — "Run agent…" + "Approve pending plan"

**Files:**
- Modify: `apps/web/src/components/command-palette.tsx` (register two commands inline, matching the existing `matches()` pattern)
- Create: `apps/web/src/components/cmd-k/run-agent-command.tsx` (the two-step picker rendered when the command is chosen) + `.test.tsx`

**Scope:** "Run agent…" opens a two-step picker (agent → parent doc) + optional input, then `useCreateRun().mutate(...)`. "Approve pending plan" lists `useRuns(...,{status:'awaiting_approval'})` workspace-wide and navigates to the parent's slideover on select. Run-create from the UI is a human/session caller → the autonomy gate (mit 54) does NOT block it.

- [ ] **Step 1: Write the failing test** (the picker component — palette registration is integration-tested by the existing palette test)

```tsx
// apps/web/src/components/cmd-k/run-agent-command.test.tsx
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { RunAgentPicker } from './run-agent-command.tsx';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, init) => {
    const u = String(url);
    if (init?.method === 'POST' && u.endsWith('/runs')) {
      return new Response(JSON.stringify({ data: { run_id: 'r9', status: 'planning' } }),
        { status: 201, headers: { 'content-type': 'application/json' } });
    }
    // agents list
    return new Response(JSON.stringify([{ slug: 'bot', title: 'Reply Bot' }]),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('RunAgentPicker', () => {
  test('selecting an agent + parent + submitting calls create run', async () => {
    const onDone = vi.fn();
    wrap(<RunAgentPicker wslug="acme" onDone={onDone} />);
    // Step 1: pick agent (implementation provides inputs/options — adjust selectors to match)
    fireEvent.change(await screen.findByLabelText(/agent/i), { target: { value: 'bot' } });
    fireEvent.change(screen.getByLabelText(/parent/i), { target: { value: 'task-1' } });
    fireEvent.click(screen.getByRole('button', { name: /run/i }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun run test src/components/cmd-k/run-agent-command.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation** — `RunAgentPicker` (agent select + parent input + optional input textarea → `useCreateRun`), exporting a small component. Register both commands in `command-palette.tsx` using the existing `matches({ label: 'Run agent…' }, query)` + `<CommandItem onSelect={...}>` pattern; the `onSelect` opens the picker (lift a piece of local state in the palette, or route to a dedicated picker overlay). Keep the picker dumb and controlled.

> **⚠️ E-5 ground-truth note (Step 2.5):** Read `command-palette.tsx` fully to see how an action that opens a SECONDARY UI (not just navigation) is wired today — there may be no precedent, in which case the simplest approach is a local `useState` in the palette that swaps the command list for the picker. Read `useWorkspaceAgents` (recon: used by MentionPicker) for the agents list hook + its return shape. The test selectors above are illustrative — match them to the real inputs you build.

- [ ] **Step 4: Run test to verify it passes** + re-run the existing palette test.

Run: `cd apps/web && bun run test src/components/cmd-k/ src/components/command-palette.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd apps/web && bunx tsc --noEmit
git add apps/web/src/components/cmd-k/ apps/web/src/components/command-palette.tsx
git commit -m "phase-3: Cmd-K run-agent + approve-pending-plan (E-5)"
```

---

### Task E-6: Approval-buttons live run state

**Files:**
- Modify: `apps/web/src/components/comments/approval-buttons.tsx` + its test

**Scope:** Extend `ApprovalButtons` to query the linked run via `useRun(wslug, planComment.frontmatter.run_id)` and reflect live run state alongside the existing approval-resolution rendering: interactive Approve/Reject only while the run is `awaiting_approval`; a muted "Approved by @x · 3m later" once running/completed; muted "Rejected …" on rejected. SSE (via the parent slideover's `useRunsLiveSync` / the run's own invalidation) keeps `useRun` fresh. **Do NOT change the approval POST path** — approval still posts a `kind=approval` comment with `target_agent` (D-8 normalized slug handling); the builtin-on-approval trigger + D-5 resume_run does the rest.

- [ ] **Step 1: Write the failing test** — add a case: given a `planComment` with `frontmatter.run_id='r1'` and `useRun` returning `{frontmatter:{status:'awaiting_approval'}}`, the buttons are interactive; when `useRun` returns `status:'running'`, the buttons are replaced by the muted resolved line. Mock `fetch` for the run GET.

```tsx
// addition to apps/web/src/components/comments/approval-buttons.test.tsx
test('renders interactive buttons only while linked run is awaiting_approval', async () => {
  // stub fetch: GET /runs/r1 → { data: { frontmatter: { status: 'awaiting_approval' } } }
  // render ApprovalButtons with planComment.frontmatter.run_id = 'r1'
  // assert Approve + Reject buttons present
});
test('replaces buttons with muted state once linked run is running', async () => {
  // stub fetch: GET /runs/r1 → status 'running'
  // assert no Approve button; muted text present
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun run test src/components/comments/approval-buttons.test.tsx`
Expected: FAIL (new assertions).

- [ ] **Step 3: Write the implementation** — thread `wslug` into `ApprovalButtons` props (it currently takes `workspaceSlug`), call `useRun(workspaceSlug, planComment.frontmatter.run_id as string | undefined)`, and gate the interactive branch on `run?.frontmatter.status === 'awaiting_approval'`. Preserve all existing guards (`kind=plan`, agent author) and the existing `findResolution` rendering as the fallback when there's no `run_id`.

> **⚠️ E-6 ground-truth note (Step 2.5):** Confirm `planComment.frontmatter.run_id` is the actual field name a plan comment carries (grep the server side where plan comments are created — D-5/C area). If plan comments don't carry `run_id`, E-6 must resolve the run another way (e.g. by `parent_id` + agent). Lock the linkage field before writing. Also: `ApprovalButtons` already receives `workspaceSlug` — reuse it; no new prop needed for wslug.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && bun run test src/components/comments/approval-buttons.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd apps/web && bunx tsc --noEmit
git add apps/web/src/components/comments/approval-buttons.tsx apps/web/src/components/comments/approval-buttons.test.tsx
git commit -m "phase-3: approval buttons reflect live run state (E-6)"
```

---

### Task E-7: Provider-health banner + reactor-halt banner + inline notices

**Files:**
- Create: `apps/web/src/components/shell/provider-health-banner.tsx` + `reactor-halt-banner.tsx` (+ tests)
- Modify: `apps/web/src/routes/__root.tsx` (mount both banners above `<Outlet />` in the `!isAuthRoute` branch)
- Modify: the agent slideover for the inline "provider offline" notice; `workspace-settings.tsx` to honor `?tab=ai&provider=<p>`

**Scope:** `ProviderHealthBanner` reads `useProviderHealth(wslug)`; if any provider is `degraded`, render a dismissible banner naming the provider(s) with a "Check key →" link to `?tab=ai&provider=<p>`. `ReactorHaltBanner` reads `useReactorHealth(wslug)`; if `halted`, render a system banner with the error class (no tenant data). The reactor banner is workspace-global (system event broadcast, mit 53).

- [ ] **Step 1: Write the failing tests** — `ProviderHealthBanner` renders nothing when all healthy; renders the banner + "Check key" link when one provider is degraded. `ReactorHaltBanner` renders nothing when `halted=false`, renders the error class when `halted=true`. Mock `useProviderHealth`/`useReactorHealth` or stub fetch+EventSource.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web && bun run test src/components/shell/`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the implementations** — two small presentational components reading the E-2b hooks. Banner copy + the `Link`/navigation to the AI settings tab with `?tab=ai&provider=<p>`. Mount both in `__root.tsx`. Wire the workspace-settings tab to read `tab`/`provider` search params and preselect.

> **⚠️ E-7 ground-truth note (Step 2.5):** (1) Need `wslug` in `__root.tsx` to call the hooks — the root may not know the active workspace. Read how the active workspace slug is derived (router params / a context provider). If `__root` can't resolve it, mount the banners one level down (the authenticated layout route that DOES have `:wslug`). (2) Read `workspace-settings.tsx` to confirm the tab state mechanism + how to read search params (TanStack `useSearch`). (3) Confirm the AI settings tab's existing query-param contract (Phase 2 shipped the tokens/AI tabs).

- [ ] **Step 4: Run tests to verify they pass + re-run `__root`/settings tests for regression.**

- [ ] **Step 5: Commit**

```bash
cd apps/web && bunx tsc --noEmit
git add apps/web/src/components/shell/ apps/web/src/routes/__root.tsx apps/web/src/components/slideover/workspace-settings.tsx
git commit -m "phase-3: provider-health + reactor-halt banners + AI-tab deep link (E-7)"
```

---

### Task E-8: `[[` wiki-link picker in the Milkdown body editor

**Files:**
- Modify: `apps/web/src/components/slideover/body-editor.tsx` (+ test) — add `[[` detection that opens `WikiLinkPicker` and inserts `[[<slug>]]`

**Scope:** The body editor already has slash (`/`) detection + a `SlashMenu` (lines 73-122). Add a parallel `[[` trigger that opens the existing `WikiLinkPicker` (Phase 2.6) positioned at the caret; selecting a doc inserts `[[<slug>]]` into the Milkdown document. Pure web; reuses the picker.

- [ ] **Step 1: Write the failing test** — typing `[[` opens the picker; selecting inserts `[[<slug>]]`. jsdom + Milkdown interaction may be limited — if so, write a unit test for the `[[`-detection function + a Playwright TODO (mirror the Phase 2.6 `[[` deferral pattern).

- [ ] **Step 2: Run test to verify it fails.**

Run: `cd apps/web && bun run test src/components/slideover/body-editor.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the implementation** — mirror the existing slash-detection state machine for `[[`; render `<WikiLinkPicker workspaceSlug={...} projectSlug={...} query={...} onSelect={insert} onClose={...} />`; `onSelect` inserts `[[${slug}]]` at the caret and closes.

> **⚠️ E-8 ground-truth note (Step 2.5):** Read `body-editor.tsx` lines 73-179 fully to mirror the EXACT slash-detection + menu-positioning machinery (rect, query, ctx). The recon confirmed `SlashMenu` + slash detection exist; replicate the pattern for `[[` rather than inventing a new one. Confirm `WikiLinkPicker`'s `onSelect` shape `{slug, title}` (recon-verified) and that the editor has `workspaceSlug`/`projectSlug` in scope.

- [ ] **Step 4: Run test to verify it passes.**

- [ ] **Step 5: Commit**

```bash
cd apps/web && bunx tsc --noEmit
git add apps/web/src/components/slideover/body-editor.tsx apps/web/src/components/slideover/body-editor.test.tsx
git commit -m "phase-3: [[ wiki-link picker in body editor (E-8)"
```

---

### Task E-9: Sub-phase E integration gate

- [ ] **Step 1: Full web suite green** — `cd apps/web && bun run test` (expect prior 559 + E additions, 0 fail; the `list-view-create.test.tsx` flake may need one rerun per `[[known-test-flakes]]`).
- [ ] **Step 2: Server + shared suites unchanged** — `cd apps/server && bun test` (960/1/0), `cd packages/shared && bun test` (53/0). E is web-only; these must not move.
- [ ] **Step 3: Typecheck clean** — `cd apps/web && bunx tsc --noEmit` (clean for touched files; pre-existing errors unchanged).
- [ ] **Step 4: Run `netdust-core:integration`** to advance the marker.
- [ ] **Step 5: `/code-review --base=cf5b2f6 --effort=medium`** over the E diff. Verify E inherits mitigations 1–66 (no new server surface). Sibling-site audit on any touched shared/server file.
- [ ] **Step 6: Manual smoke** (controller or user): assign a work item to an agent via the UI → run executes → `kind=result` comment appears → runs table shows the row → status flips live without a manual refresh (proves the SSE→invalidate wire).
- [ ] **Step 7: `netdust-core:evaluate`** — Sub-phase E retro.
- [ ] **Step 8: Mark Sub-phase E complete in `docs/PHASES.md`.**

---

## Self-Review

**Spec coverage** (vs the mega-plan §"Sub-phase E" outline E-1..E-9):
- E-1 runs hooks → covered by **E-2** (hooks) + **E-1** (the SSE primitive split out, per the locked design). ✅
- E-2 `useProviderHealth` → **E-2b**. ✅
- E-3 runs link tile → **E-3** (reconciled: fills the existing `'runs'` tab; `?agent=` = slug). ✅
- E-4 runs table render → **E-4** (Playwright smoke, gated). ✅
- E-5 Cmd-K commands → **E-5**. ✅
- E-6 approval-buttons live → **E-6** (reconciled: reuse existing `workspaceSlug` prop, gate on linked-run status). ✅
- E-7 banners + AI-tab deep link → **E-7** (added reactor-halt banner per handoff; C.3 deferred it to E). ✅
- E-8 `[[` wiki-link → **E-8**. ✅
- E-9 integration gate → **E-9**. ✅

**Placeholder scan:** Several tasks carry explicit `⚠️ ground-truth note (Step 2.5)` blocks rather than placeholders — these are *deliberate reconciliation gates* for the implementer to resolve against live source at dispatch time (the route tree, the slideover props, the plan-comment `run_id` linkage, the reactor payload key, the Playwright harness existence). They are NOT "TODO/fill-in-later" placeholders; each names the exact file to read and the exact decision to lock. This is the Step 2.5 discipline the handoff mandates, surfaced where the recon couldn't reach a definitive answer without the implementer touching the file.

**Type consistency:** `runsKeys`, `AgentRunDoc`, `RunsFilter`, `useEventStream`/`StreamedEvent`/`EventStreamFilters`, `ProviderHealth`/`ProviderEntry`, `useRunsLiveSync` are defined once (E-1/E-2/E-2b) and referenced consistently downstream (E-3/E-6/E-7). The 6 `agent.run.*` kinds are listed identically in E-1's `RUN_KINDS` and match the verified shared enum.

**Open reconciliations the implementer MUST close (carried, not guessed):**
1. Hono `streamSSE` named-event routing (E-1) → every consumer passes explicit `kinds`. **Highest priority — verify first.**
2. The runs-table route path + search-param contract (E-3/E-4).
3. `reactor.halted` payload error-class key (E-2b).
4. Plan-comment → run linkage field (`run_id`?) (E-6).
5. Whether `__root.tsx` can resolve the active `wslug`, else mount banners one level down (E-7).
6. Playwright harness existence on this branch (E-4) — else fold into F manual QA.

---

## Execution Handoff

Per `tasks/todo.md` + the handoff: dispatch via **`netdust-core:ntdst-execute-with-tests`** (upstream = `subagent-driven-development`), Step 2.5 per task (each task's ground-truth note is the reconciliation target), two-stage review per task, re-verify test counts (`[[verify-subagent-test-counts]]`). **E-1 first** — E-2/E-2b/E-3/E-6/E-7 depend on it.
