# Sub-phase E — Readiness Handoff (Web UI: runs table + link tiles + Cmd-K + banners + wiki-links)

**Branch:** `phase-3/agent-runner` (NOT pushed)
**HEAD at handoff:** `f557dac` (auto-capture on top of `255c3e1` = the D-9 closeout). D+D-9 code range = `cad6443..255c3e1` (33 commits incl. memory).
**Test baseline:** server **960 pass / 1 skip / 0 fail** · web **559 / 8 skip / 0 fail** · shared **53 / 0**. tsc clean (server + web + shared touched files). 2 pre-existing root-`tsconfig` errors in `scripts/` (`bun:test` types + a `seed-demo.ts` undefined) — NOT in any sub-phase's blast radius; ignore.
**Markers:** `.claude/.last-integration` = `9748a64` (the D-8 fix commit — **advance to `255c3e1` by running `/integration` once at E start**, since D-9 shipped past it). `.claude/.last-evaluate` = `3bd6c57` (still the C.3 retro — D + D-9 retros not yet run).

Sub-phases A→D + D-9 are COMPLETE: the agent runner is functionally whole on the server — routes, MCP parity, the unified tool surface, the approval/resume loop, and self-correcting tool errors. **Sub-phase E is the WEB UI on top — the first time a human sees any of this in a browser.** E is server-API-complete (D shipped every endpoint E consumes); E is almost entirely `apps/web` work.

---

## ⛔ Before E code — two cheap things

### 1. Advance the integration marker (30 seconds)
D-9 shipped after the last `/integration` (marker at `9748a64`). Run `netdust-core:integration` once at E start — it'll confirm the D+D-9 group still composes (server 960 / web 559 / shared 53) and advance `.last-integration` to `255c3e1`. This also re-runs the gate's defense-in-depth before E layers on.

> ⚠️ **Test-runner gotcha (locked lesson):** `bun test` from the REPO ROOT mixes Vitest (web) into Bun's runner → ~450 spurious "failures" (the `interceptor.js` import noise). NEVER trust a root run. Run each workspace with its own runner: `cd apps/server && bun test` (Bun), `cd packages/shared && bun test` (Bun), `cd apps/web && bun run test` (Vitest). See `[[bun-test-from-repo-root-forbidden]]`.

### 2. (Optional) the user-run D + D-9 `/evaluate` retros
Not a blocker for E, but the D and D-9 sub-phase retros (`netdust-core:evaluate`) haven't run. They're billed/user-run. If you want the process-retro before piling on E, run them now; otherwise they can batch at the Phase-3 close. The D-8 `/code-review` already ran (4 findings fixed); `/evaluate` is the separate "how was it executed" pass.

---

## What Sub-phase E delivers (9 tasks — outline at mega-plan ~line 4543)

These are OUTLINE-ONLY in `docs/superpowers/plans/2026-05-27-phase-3-agent-runner.md` (§"Sub-phase E", ~4543). **Per the recurring trap (and the C/D pattern): EXPAND + RECONCILE the E task bodies into executable Steps/Tests/Commit BEFORE dispatching any subagent.** E integrates against (a) the D server endpoints (verify their real response shapes — see "D surface E consumes" below) and (b) a lot of existing Phase 1.5/1.6/2.6 web components. Ground-truth both per `ntdst-execute-with-tests` Step 2.5.

| Task | Outline scope | Key reconciliation watch-out |
|---|---|---|
| **E-1** | `apps/web/src/lib/api/runs.ts` — `useRuns(filter)` / `useRun(id)` / `useCreateRun()` / `useCancelRun()` / `useRetryRun()` react-query hooks, optimistic. | Must match D-1's REAL response shapes: list = `jsonOk` envelope `{data: AgentRun[]}`; create/cancel/retry return `{run_id, status}`. The runs are `documents` rows of `type='agent_run'` — reuse the existing document hooks/types where possible. Verify the envelope (`jsonOk` `{data}`) vs bare. |
| **E-2** | `apps/web/src/lib/api/provider-health.ts` — `useProviderHealth(wslug)`: one-shot `GET /provider-health` on mount + SSE merge of `workspace.provider.degraded`/`recovered`. | D-1's `/provider-health` returns camelCase `{anthropic:{status,consecutiveFailures}, ...}`. SSE filters now support `?agent=`/`?table=` (D-7) AND-combined with `?project=`/`?parent=`/`?run=`. |
| **E-3** | Runs link tile on agent + trigger slideovers (`components/runs/runs-link-tile.tsx`). Live-updates via `?agent=<slug>` SSE. | **`?agent=` matches the agent SLUG** (D-7 decision — events carry `payload.agent` = slug, NOT the doc id). Pass the slug. |
| **E-4** | Runs table rendering — the runs table is just a lazy-seeded `tables` row (`slug='runs'`); verify it renders via the existing TableView. Playwright smoke. | No new render code — the runs table + its 3 lazy-seeded views already exist (C-6 `ensureRunsTable`). E-4 is mostly a Playwright check. |
| **E-5** | Cmd-K: "Run agent…" (agent→parent picker → `POST /runs`) + "Approve pending plan" (list `?status=awaiting_approval`). | Run-create from the UI is a HUMAN/session caller → the autonomy gate (mit 54) does NOT block it (gate only fires for agent-bound bearers). Approve = post a `kind=approval` comment (the builtin-on-approval trigger + D-5 resume_run does the rest). |
| **E-6** | Approval-buttons live state (`components/comments/approval-buttons.tsx`) — queries the linked run via `useRun(comment.frontmatter.run_id)`; interactive only on `awaiting_approval`. | **Approval posts a `kind=approval` comment with `target_agent`** — D-8 fixed the matcher to normalize `agent:`-prefixed slugs, so either form works, but prefer the bare slug or the `target_agent_id` doc-id handle. Cancel-of-running posts `kind=rejection` (D plan correction — there is no `cancel` comment kind). |
| **E-7** | ProviderHealth banner (`components/shell/provider-health-banner.tsx`) + agent-slideover inline "offline" notice. "Check key" → AI settings tab w/ `?tab=ai&provider=<p>`. **ALSO the reactor-halt banner** (C.3 shipped `reactor.halted`/`recovered` events + the `workspaceId:null` bus broadcast — E renders the banner). | The reactor-halt banner is NEW scope the C.3 spec §4b deferred to E. `reactor.halted` is a system event broadcast to ALL workspaces (mitigation 53 — error CLASS name only, no tenant data). |
| **E-8** | `[[` wiki-link picker in the Milkdown body editor (`document-slideover.tsx`) — wires the existing `WikiLinkPicker` (Phase 2.6). | Pure web; reuses the Phase 2.6 picker. |
| **E-9** | Sub-phase E integration gate: full suite + tsc + manual smoke (assign via UI → run executes → result comment → runs table shows the row). | Then `/code-review` + `/evaluate`. |

---

## D surface E consumes (verify shapes at E-plan-write, Step 2.5)

All shipped + reviewed. Read these before writing E-1/E-2 hooks:
- **`routes/runs.ts`** (D-1, `2ecb1b4`): `GET /api/v1/w/:wslug/p/:pslug/runs?status=&agent=&since=` (list, `jsonOk {data}`), `GET /api/v1/w/:wslug/runs/:runId`, `POST /api/v1/w/:wslug/runs {agent_slug,parent_slug,input?}` → `{run_id,status}`, `POST .../runs/:runId/cancel`, `POST .../runs/:runId/retry`, `GET /api/v1/w/:wslug/provider-health` → `{anthropic,openai,openrouter,ollama}` each `{status,consecutiveFailures}`.
- **`routes/admin-runner-stats.ts`** (D-6, `d32f78e`): `GET /api/v1/w/:wslug/admin/runner-stats` → `{pending_count,active_count,recovered_today}`. **SESSION-ONLY** (D-8 fix: `authMethod==='token'`→403) + owner/admin. An ops/admin UI surface if E wants it (not in the E outline — optional).
- **SSE** (`routes/events.ts`, D-7 `707f070`): query params `?project=`, `?kinds=`, `?parent=`, `?run=`, **`?agent=`** (slug), **`?table=`** (tableId) — all AND-combined. New run-lifecycle event payloads carry `agent` (slug) + `table_id`.
- **5 run MCP tools** (D-4, `a316508`): `list_runs/get_run/run_agent/cancel_run/retry_run` — HTTP twins of the above (E is web/HTTP, won't use these, but they exist for agents).
- **Event kinds E renders:** `agent.run.started|running|completed|failed|rejected|awaiting_approval`, `workspace.provider.degraded|recovered`, `reactor.halted|recovered`, `agent.chain.suppressed`.

## Existing web components E builds on (Phase 1.5/1.6/2.6 — reuse, don't rebuild)
- TableView + saved-views rail (Phase 1.5/1.6) — the runs table renders through this (E-4).
- TabStrip slideover, CommentRow, ApprovalButtons, MentionPicker, WikiLinkPicker (Phase 2.6) — E-6/E-8 extend these.
- The SSE client hook pattern (Phase 2.6 used react-query only, NO SSE client per `[[realtime-and-locking-deferred]]` — **E-2/E-3 INTRODUCE the SSE-on-slideover client**; check whether that deferral is being lifted for E or if E uses one-shot fetch + react-query invalidation. This is a design decision to lock at E-plan-write).

---

## Carried obligations + deferred items (read `tasks/retro-follow-ups.md`)
- **D-R-1** — allow-list derivation triplicated (runs.ts ctx + registry token + events.ts). Server cleanup; not E-blocking. Revisit at next touch.
- **D-R-2** — cancel-of-running overloads `kind=rejection`. E-6 renders comments — if a "rejection that means cancel" looks wrong in the UI, this is why; the deeper fix (a first-class `cancel` kind) is deferred. E may want to render cancel-rejections distinctly.
- **D-R-3** — create/cancel/retry verb bodies duplicated HTTP vs MCP. Server cleanup; not E-blocking.
- **C.1-R-1** — `events.document_id` FK cascade: PARKED (D added no hard-delete; only relevant if a future v1.1 adds `DELETE /runs/:id`).
- **D + D-9 `/evaluate`** retros not yet run (see above).

## Threat model
E is mostly client rendering — lower attack surface than D. BUT: E-2/E-3 open SSE streams (the F3 allow-list + subject-visibility filters on `routes/events.ts` already gate what an agent-bound bearer sees — E's client just consumes; don't bypass). E-5's "Run agent" + E-6's approve/reject POST through the D endpoints (already gated). If E adds any NEW server endpoint (unlikely — D shipped them all), invoke `netdust-core:threat-modeling` and extend mitigations 67+. Otherwise E inherits 1–66; no new server surface expected.

## Mandatory skill order (E session)
1. `superpowers:using-superpowers` (first turn).
2. **Plan-writing first** (E is outline-only): `superpowers:writing-plans` — expand E-1..E-9 to executable bodies, reconciling against the D response shapes (above) + existing web components. (Threat-modeling only if E adds a server endpoint — it shouldn't.) Plan-correction commit.
3. THEN `netdust-core:ntdst-execute-with-tests` (upstream = `subagent-driven-development`). Step 2.5 per task (ground-truth the D shape + the existing component each task touches). Two-stage review per task; re-verify test counts yourself (`[[verify-subagent-test-counts]]`). Web tests are Vitest (`cd apps/web && bun run test`), e2e is Playwright (`bun run e2e`).
4. `netdust-core:testing-workflow` per task (subagent-invoked).
5. (controller, E-9) `netdust-core:integration` → `/code-review --base=255c3e1 --effort=medium` → `netdust-core:evaluate`.

## After E closes
**Sub-phase F** — shake-out (`netdust-core:shake-out`, exercise the whole agent-runner flow in a real dev server with a BYOK key) + Playwright e2e + `superpowers:finishing-a-development-branch` to merge `phase-3/agent-runner` → main. F is where the C-13 manual dev-server smoke (run headless in D) finally gets a real-browser pass with live provider streaming.

## First-turn checklist (E session)
1. `superpowers:using-superpowers`.
2. `netdust-core:integration` (advance marker `9748a64`→`255c3e1`, confirm group composes).
3. Read this handoff + the mega-plan §"Sub-phase E" outline + the D response shapes + `tasks/retro-follow-ups.md`.
4. **Expand + reconcile the E plan** (`writing-plans`) — D shapes, existing web components, the SSE-client design decision (lift the Phase-2.6 no-SSE-client deferral or not). Plan-correction commit.
5. THEN dispatch via `ntdst-execute-with-tests`. E-1 (runs hooks) first — E-3/E-4/E-6 depend on it.
6. E-9 controller gate.

If anything's stuck, STOP and reach for the user. Don't improvise around the discipline.
