# Phase 3 Sub-phase E — Agent Surface Design

**Date:** 2026-05-30
**Status:** Approved (brainstorm complete) — supersedes the "runs table" framing in `docs/superpowers/plans/2026-05-30-phase-3-E-web-ui.md` (E-3..E-9) and the readiness handoff's TableView-reuse premise.
**Branch:** `phase-3/agent-runner`

---

## The reframe (why this exists)

The original E plan assumed "runs are just a lazy-seeded `tables` row that renders through the existing `TableView`." Ground-truthing during execution proved that false on three layers (captured in `memory/project_runs-not-a-tableview.md`):

1. The web UI has no multi-table navigation (clicking a table ignores `tslug`, always opens `/work-items`).
2. `TableView` doesn't type-scope rows by table.
3. **Decisive:** `agent_run` documents are deliberately walled off from the generic `/documents` endpoint (`routes/documents.ts` → `AGENT_RUN_REQUIRES_RUNNER_PATH`) because their frontmatter holds operator-sensitive data (system_prompt, tokens, provider). Runs are readable **only** via the dedicated `/runs` endpoints.

**The corrected mental model (the human is the reviewer):**

- **The agent's real OUTPUT is the markdown docs/tables it writes** — already reviewed through the normal app. The runs surface does NOT re-surface the deliverable.
- **A "run" is the EXECUTION RECORD** — operational metadata (when it ran, what fired it, status, tokens, errors), not the deliverable.
- **Approval lives in comments** — the comment thread is the one place a human talks to an agent. Approve/reject is a `kind=approval` comment.
- **Run history lives on the agent** — a section on the agent's own slideover.
- **Event-triggered agents currently have NO UI** (cron / webhooks / `builtin-on-assignment` run invisibly). A toggleable **agent side-panel** makes them visible and gives a place to launch agents.

---

## Three surfaces

### 1. Approval — in comments (E-6, no new surface)
`approval-buttons.tsx` already renders Approve/Reject on `kind=plan` comments. E-6 makes it reflect **live run state**: interactive only while the linked run is `awaiting_approval`; muted "Approved/Rejected by @x · 3m later" once resolved. Live via the run's react-query cache (kept fresh by `useRunsLiveSync`).

**Linkage (decided):** the runner will **stamp `run_id` into `kind=plan` comment frontmatter** (the comment schema already permits `run_id`; the runner currently defers it — `runner.ts:814`). Approval buttons then call `useRun(wslug, comment.frontmatter.run_id)` — direct, unambiguous. This is a small server task (E-4b).

### 2. Run history — on the agent (E-4)
The agent slideover gains a **Runs** screen listing that agent's execution records: status chip, fired-by (manual / trigger:<id> / assignment), started-at, tokens (in/out), error reason. Backed by the project-scoped `GET /api/v1/w/:wslug/p/:pslug/runs?agent=<slug>` (shipped) + `useRunsLiveSync` for live status. Read-only.

**v1 simplification (decided):** an agent can span multiple projects (allow-list), but there is no workspace-wide runs-list endpoint. v1 shows the agent's **primary project** runs (the first allow-listed project, or the project context the panel was opened from), with a note. Full cross-project rollup is deferred.

### 3. Agent side-panel — the new visibility surface (E-5)
A toggleable right-side panel using a **NocoDB-style icon-tab header** (compact icon toolbar: title · icon-tab group · overflow · expand · close). Two distinct icon-tab **screens**:

- **▶ Run** — a launcher: agent picker → target (project, optional doc) → optional instruction textarea → "Run agent →" (`POST /runs`). The "ask an agent to build a project" entry point. Opened by **Cmd-K "Run agent…"**.
- **⚡ Activity** — a workspace-wide live feed of recent agent runs. Each row: *agent · ran on <doc> · status chip · fired-by · relative time →*, linking to the doc's slideover + comments tab (where interaction lives). Opened by the panel toggle.

When opened **from a specific agent's slideover**, the same panel also offers a **🗐 Runs** tab (that agent's history, surface #2 reused).

**Why the feed is SSE-driven (decided):** there is no workspace-wide runs-list endpoint, but the SSE event stream IS workspace-wide and carries every `agent.run.*` event (agent slug, doc, status) with bounded `Last-Event-Id` replay. The feed = a small bounded backfill on open (merge the project runs the user can see) + a live tail via `useEventStream`. No new server endpoint for the feed. This means the feed shows recent/live activity well; "every run from last month" is a later feature (lives on the agent's per-project history).

---

## Components (8 units, each reuses shipped hooks + existing patterns)

| Unit | New/Mod | Responsibility | Depends on |
|---|---|---|---|
| **`RunStatusChip`** | new | Status → colored chip (planning/running/awaiting_approval/completed/failed/rejected). Presentational. | — |
| **`RunRow`** | new | One run's row: status chip + agent + doc + fired-by + time + (optional) tokens/error. Shared by feed + history. | `RunStatusChip` |
| **`PanelHeader`** | new | Shared NocoDB-style icon-tab header (title · icon-tab group · overflow · expand · close). Built drop-in so the doc slideover can adopt it later. | — |
| **`RunsHistorySection`** | new | Agent's run history (primary project). Rows via `useRuns({agent})` + `useRunsLiveSync`. Read-only. | E-2 hooks, `RunRow` |
| **`useActivityFeed(wslug)`** | new | Feed engine: bounded backfill (recent accessible project runs) → seed list (cap ~50) → `useEventStream` prepends live `agent.run.*`, deduped by run id. Returns `{items, isLoading}`. SSE appends to a local live-tail list (justified like `useReactorHealth` — documented). | E-1, E-2 |
| **`AgentRunLauncher`** | new | ▶ Run screen: agent select + target + instruction → `useCreateRun`. Human/session caller (autonomy gate doesn't block). | E-2 |
| **`AgentSidePanel`** | new | The panel shell: `PanelHeader` + icon-tab routing between ▶ Run (`AgentRunLauncher`), ⚡ Activity (`useActivityFeed` + `RunRow` list), and 🗐 Runs (`RunsHistorySection`, when agent-scoped). Toggle state in a small context or URL param. | all above |
| **`approval-buttons.tsx`** | mod (E-6) | Query linked run via `useRun(run_id)`; live interactive/muted state. | E-2 |

**Plus, unchanged from the prior plan:**
- **E-7** — provider-health + reactor-halt banners + AI-tab deep link (backed by E-2b, mount in `__root.tsx`).
- **E-8** — `[[` wiki-link picker in the Milkdown body editor (reuses Phase-2.6 `WikiLinkPicker`).

**Already shipped (the data/realtime layer — foundation, do not redo):** E-1 `useEventStream` (`9a05c00`+`0726767`), E-2 runs hooks + `useRunsLiveSync` (`029c20d`+`6858ba7`), E-2b provider/reactor health (`bae6c14`+`9a8fb09`).

---

## Data flow

```
LAUNCHER (▶ Run):
  pick agent + target + instruction → useCreateRun → POST /runs → new run
  → appears in ⚡ Activity via SSE

ACTIVITY FEED (⚡):
  open → useActivityFeed backfills recent accessible project runs → seed list
       → useEventStream(agent.run.*) → prepend live, dedup by run id, cap ~50
  row click → navigate to doc slideover + comments tab

RUN HISTORY (🗐, agent-scoped):
  useRuns(wslug, primaryProject, {agent: slug}) + useRunsLiveSync → RunRow list

APPROVAL (in comments, E-6):
  plan comment carries run_id (server stamp, E-4b)
  → useRun(run_id) → interactive while awaiting_approval, muted when resolved
```

---

## Error handling

- `useRuns` / `useEventStream` failures → empty-with-retry state; never a crash.
- Feed backfill iterates the user's accessible projects; a single project's 403/error is skipped, not fatal to the whole feed.
- SSE drop → native `EventSource` reconnect (E-1 already handles) + `Last-Event-Id` replay.
- Launcher `POST /runs` errors (409 already-active, 404 parent/agent, 403 allow-list) → inline toast with the server `error.code`.
- Banners (E-7): provider/reactor state already gated server-side; client only renders.

---

## Testing

Vitest + the shipped stub patterns (`vi.stubGlobal('fetch')`, `MockEventSource`, `renderHook` + `QueryClientProvider`). Per unit:

- **`RunStatusChip`** — status → color/label mapping (all 6 statuses).
- **`RunRow`** — renders agent/doc/fired-by/time; tokens+error when present.
- **`PanelHeader`** — renders title + icon tabs; active-tab highlight; tab click fires `onTabChange`; close/expand callbacks.
- **`RunsHistorySection`** — rows from `useRuns`; live-updates via sync; read-only (no edit affordances).
- **`useActivityFeed`** — backfill seeds list; live event prepends; dedup by run id (started→running collapse to one row); cap enforced.
- **`AgentRunLauncher`** — agent+target+submit → `useCreateRun` called with `{agent_slug,parent_slug,input}`; error surfaces.
- **`AgentSidePanel`** — Cmd-K opens on ▶ Run; toggle opens on ⚡ Activity; agent-scoped open shows 🗐 Runs; tab switching.
- **`approval-buttons.tsx` (E-6)** — interactive only on `awaiting_approval`; muted when resolved; resolves run via `run_id`.
- **E-4b (server)** — `kind=plan` comments created by the runner carry `run_id` in frontmatter; existing comment tests unaffected.
- **E-7 / E-8** — as in the prior plan.
- **Playwright smoke (F):** assign a doc to an agent → run executes → appears in ⚡ Activity AND the agent's 🗐 Runs → click feed row → lands on doc + comments tab.

---

## Threat model

E adds **one** small server change (E-4b: stamp `run_id` on plan comments). `run_id` is a non-sensitive identifier (a nanoid already visible to anyone who can read the run via `/runs`); stamping it into a comment the same caller can already read introduces no new exposure. No new endpoint, no new auth surface. The launcher (E-5) and approval (E-6) POST through D's already-gated `/runs` + comment endpoints (autonomy gate mit 54 fires only for agent-bound bearers; a human/session caller is allowed by design). The activity feed consumes the SSE stream, whose per-bearer allow-list + subject-visibility filters (`agent-event-visibility.ts`) already gate what a connection sees — the client only consumes, never bypasses. **E inherits mitigations 1–66; E-4b is covered by the existing comment-write gates.** No threat-model extension required beyond noting E-4b's non-sensitivity here.

---

## Revised task list (replaces dead E-3/E-4)

| Task | What |
|---|---|
| **E-3** | `RunStatusChip` + `RunRow` shared presentational components |
| **E-4** | `RunsHistorySection` (agent's run history, primary project) |
| **E-4b** | Server: stamp `run_id` on `kind=plan` comments (the runner's plan-comment write) |
| **E-5** | `PanelHeader` + `AgentRunLauncher` + `useActivityFeed` + `AgentSidePanel` + shell toggle + Cmd-K "Run agent…" opens it |
| **E-6** | Approval buttons live state (via stamped `run_id`) |
| **E-7** | Provider + reactor banners + AI-tab deep link *(unchanged from prior plan)* |
| **E-8** | `[[` wiki-link picker *(unchanged)* |
| **E-9** | Integration gate + Playwright smoke |

E-5 is the largest task (panel shell + 3 screens + feed engine) — when writing the plan, consider splitting it into E-5a (PanelHeader + AgentSidePanel shell + toggle), E-5b (AgentRunLauncher + Cmd-K), E-5c (useActivityFeed + Activity screen).

---

## Deferred / follow-up (tracked)

- **Retrofit the existing document/work-item slideover** to the shared `PanelHeader` (NocoDB icon-tab style), replacing its text `TabStrip`. Own follow-up task/phase — accepts a temporary two-tab-style gap. The `PanelHeader` is built in E to be drop-in for this.
- **Workspace-wide runs-list endpoint** + full cross-project agent history — deferred; v1 history is primary-project, feed is SSE-driven.
- **Threaded inline interaction** in the activity feed (reply/approve inside the panel) — explicitly out of v1; the feed routes to comments instead.
- **"All runs ever" queryable view** (audit/filter across history) — later; needs the workspace-wide endpoint.
