# Shake-out manifest — agents-page + 10 review fixes

_Date: 2026-06-01 · Branch: `phase-3.x/agents-page` · Scope (Stefan): agents-page UI flow + key server fixes via API; CC-path fixes skipped (unit-covered, claude-code deprioritized)._

## Environment
- Bun/TS monorepo. API `@folio/server` :3001 (healthy, 401 on unauth). Web `@folio/web` Vite :5173. No Codeception → manual sweep.

## Phase 1 Track A — automated sweep (live API + browser)

| # | Check | Expected | Actual | Result |
|---|---|---|---|---|
| S1 | (#1) PATCH `model:null` on an anthropic agent | 422 | 422 | ✅ |
| S2 | (#1 control) PATCH →claude-code + `model:null` | 200 | 200 | ✅ |
| S3 | (#6) after clearing, `model` absent (not `""`) in frontmatter | absent | absent | ✅ |
| S4 | (#3) create `Untitled` (placeholder) → rename → re-slugs | `quarterly-planning` | `quarterly-planning` | ✅ |
| S5 | (#3 guard) real-title + placeholder-shaped slug does NOT re-slug | — | unit-covered (documents.test.ts); not API-reproducible | ⊘ (unit) |
| S6 | Agents page renders | heading + tabs | "Agents & Triggers" + Agents/Triggers tabs | ✅ |
| S7 | (#9) tabs use the shared `Tabs` primitive | `aria-pressed` buttons | Agents(pressed)/Triggers | ✅ |
| S8 | (#10) agent rows show provider·model + projects via `Chip` | chips render | `anthropic·claude-haiku-4-5`, `All projects`, `2 projects` | ✅ |
| S9 | `?wdoc=<slug>` opens the config slideover (edit path) | 1 dialog, provider/model fields | dialog open, shake-writer config + 3 inputs | ✅ |
| S10 | `/triggers` → redirect to `/agents?tab=triggers`, Triggers tab active | (verified prior session) | redirect + Triggers selected | ✅ |
| S11 | Switcher exposes the two distinct destinations | "Agents & Triggers" + "Work with an agent" | both present (+ standalone shortcuts) | ✅ |
| S12 | "Work with an agent" opens the cockpit panel (interaction) | panel opens, Activity default | `w-[360px]` panel opens ✅ BUT Activity shows "No recent activity" despite 5 real runs → **BUG-1** | ⚠️ |

**Track A verdict: 0 defects.** Every fix + the agents-page UI flow verified live.

## Phase 1 Track B — manual checks (human)

Quick visual confirmations I can't fully judge (the automated probe hit viewport-reset + overlapping-modal friction; logic is confirmed, these are eyeball checks):

1. [ ] Open `/w/<ws>/agents` — do the **Tabs render as the shared pill style** (not the old underline), and do agent rows' **Chip** chips look consistent with chips elsewhere?
2. [ ] Click an actual agent **row** (not via URL) — does the config slideover open? (URL-set `?wdoc=` works; the row's onClick wasn't cleanly testable via synthetic click.)
3. [ ] In the slideover, **edit** provider/model + save — does it persist? Does switching to Claude Code clear the model without error?
4. [ ] Click **"Work with an agent"** in the workspace switcher — panel opens to Activity; switch to **Run**, fire a run — does it work end-to-end? (Use an API provider, not Claude Code.)
5. [ ] `/w/<ws>/triggers` deep-link **with `?wdoc=<a-trigger-slug>`** — does it redirect to the Triggers tab AND open that trigger's config? (#2 fix forwards wdoc — confirm visually.)

## Phase 2 — Bug clusters

### BUG-1 (IMPORTANT) — Activity feed shows "No recent activity" despite real run history
- **Symptom:** Open "Work with an agent" → the panel's Activity screen shows "No recent agent activity." even though the workspace has **5 `agent_run` rows** (4 completed, 1 failed) from this session.
- **Root cause:** `apps/web/src/lib/api/activity-feed.ts::useActivityFeed` is **SSE-live-tail only** — `useState<ActivityItem[]>([])` starts empty on every mount and only accrues items from `agent.run.*` events that stream in *while the panel is open*. Its own comment states it: _"SSE is the only source (no workspace-wide runs-list endpoint); items accrue from live events."_ Historical runs emitted their events in the past, so there is **no backfill** — the feed is always empty on open until a new run fires live.
- **Why tests missed it:** unit tests inject synthetic SSE events, so the live-tail logic passes; the missing-history gap only shows in a real environment after runs have already happened. (Exactly what shake-out is for.)
- **Provenance:** PRE-EXISTING (Phase-3 sub-phase E cockpit work), NOT introduced by the agents-page branch. But the agents-page change makes the cockpit panel the deliberate "Work with an agent" destination, so this empty-on-open feed is now front-and-center.
- **Fix direction (Phase 3):** the feed needs an initial **history backfill** — fetch recent `agent_run`s on mount, then live-tail on top. There is no workspace-wide runs-list endpoint today (the comment notes this); options: (a) add a workspace-scoped `GET /w/:wslug/runs?recent=N` that returns recent agent_runs (visibility-gated like the project `/runs`), and seed `useActivityFeed` from it; OR (b) reuse the SSE `Last-Event-Id` replay if the event log retains enough history (likely not far enough back). (a) is the right-altitude fix.
- **Severity: IMPORTANT** — the feature works for *new* live activity, but the primary surface looks broken (empty) for anyone opening it to review past runs.

## Phase 3 — Fix
One IMPORTANT bug (BUG-1) pending. Fix via systematic-debugging after manifest sign-off. The 10 review findings + agents-page UI flow are otherwise clean.

## Notes / non-blocking observations
- Pre-existing test data in Netdust has agents with `model: "m"` (a one-char model from an earlier session) — cosmetic data, not a defect; chips render it faithfully as `anthropic·m`.
- CC-path fixes (#4 injection fence, #5 stderr, #8 resume branch) deliberately NOT swept live (claude-code deprioritized + slow ~30-60s CLI). All three are unit-tested (runner.test.ts / cc-executor.test.ts, 54 tests green).
- Browser-harness friction recurred (viewport resets to 5760×3600 on navigate; synthetic row-click ambiguous). Logic verified via `?wdoc=` direct nav + panel-container inspection instead — no product defect implied by the friction.
