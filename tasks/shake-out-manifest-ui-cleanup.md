# Shake-out manifest — UI-cleanup + body-as-prompt branch

**Date:** 2026-05-31
**Branch:** `phase-3/agent-runner` (cumulative: Phase 3 agent runner + cockpit panel + NocoDB slideover headers + body-as-prompt + all code-review fixes + the work-item-500 fix)
**Environment:** dev server live (server :3001, vite :5173), authenticated Chrome DevTools MCP session.
**Method:** Track A automated sweep via authenticated browser fetch (API) + DOM inspection (UI). Iron Law honored — no fixes during sweep.

## Track A — automated sweep results

| # | Area | Check | Expected | Actual | Verdict |
|---|------|-------|----------|--------|---------|
| 1 | Work-item CRUD | `POST documents {type:work_item, title:'Untitled'}` (the just-fixed 500 path) | 201 | **201** → `untitled-2` | ✅ PASS |
| 2 | Slug dedup | 2nd `'Untitled'` work_item | 201, deduped slug | **201** → `untitled-3` (no 500) | ✅ PASS |
| 3 | Work-item patch | `PATCH title` (inline-edit path) | 200 | **200** | ✅ PASS |
| 4 | Page create | `POST {type:page, title:'Untitled'}` | 201 | **201** → `untitled-2` | ✅ PASS |
| 5 | Agent create (body-as-prompt) | `POST agent {body:'# Prompt…', frontmatter w/o system_prompt}` | 201, body kept, no system_prompt fm | **201**; `system_prompt` frontmatter **absent** (correct) | ✅ PASS |
| 6 | Agent create (no body) | `POST agent` with no body | 201 (creatable; run-time guard catches emptiness) | **201** → `untitled-2` | ✅ PASS (by design) |
| 7 | Agent list | `GET documents?type=agent` (cockpit AgentList) | 200, array | **200**, 5 agents | ✅ PASS |
| 8 | Agent get-by-slug | `GET documents/:slug` (slideover open) | 200 | **200** | ✅ PASS |
| 9 | Runs list | `GET p/folio/runs?agent=…` (RunsHistorySection) | 200 | **200**, 0 runs | ✅ PASS |
| 10 | `?doc=` slideover | open a work_item → project DocumentSlideover (on `?doc=`) | project slideover opens (not workspace) | work_item opened the project slideover w/ Close + assignee | ✅ PASS (wdoc/doc separation holds) |
| 11 | Console on load | navigate to work-items | no errors | clean (no error/warn/exception) | ✅ PASS |

**All cleanup performed** — every probe row (work_items, page, agents) created during the sweep was deleted; DB left clean.

## Track A — NOT verifiable through this harness (→ Track B)

| # | Area | Why deferred |
|---|------|--------------|
| D1 | **Agent cockpit panel toggle** (dropdown "Agents" / Cmd-K "Run agent…" → panel opens with ⚡Activity/▶Run/🤖Agents tabs) | Synthetic JS `.click()` on Radix Popover/cmdk items does NOT fire Radix's pointer-based handlers, and the headless browser's non-standard viewport/DPR distorts the flex layout. The toggle could not be exercised reliably. **NOTE:** the wiring is confirmed in source (`Shell panel={<AgentCockpitPanel>}`, dropdown `onClick → agentPanelBus.toggle()`, Cmd-K → `agentPanelBus.open('run')`) AND unit-tested (`agent-cockpit-panel.test.tsx` asserts open/close/screen-switch via the bus, 4 tests pass; `agent-panel-bus.test.ts` passes). So this is a HARNESS limitation, not a confirmed defect — but it needs a human eyeball. |

## Track B — manual checks needed (human, in a real browser)

Please click through these and report anything off — I'll add findings to the manifest:

1. [ ] **Cockpit panel toggle.** Workspace dropdown (top-left "Netdust") → **Agents**. Does a panel slide in on the RIGHT, pushing the worktable left, with three icon tabs (Activity / Run / Agents)? Click each tab — do they switch? Click the panel's **×** — does it close?
2. [ ] **Cmd-K → Run agent.** Press Cmd/Ctrl-K → "Run agent…". Does the cockpit open on the **Run** screen?
3. [ ] **Agent config slideover.** In the cockpit's **Agents** tab, click an agent → does the config slideover open OVER the panel? Drag its **left edge** — does it resize, and does the width persist after closing + reopening?
4. [ ] **Body-as-prompt.** Create a new agent (cockpit → New agent). Is the body editor labelled **"Prompt"** with a `# Prompt` starter? Is there NO `system_prompt` field in the Fields form?
5. [ ] **NocoDB header.** Open any work-item — is the header a SINGLE row (title + icon tabs + ⋯ + ×), with the rich/raw toggle inside the ⋯ menu? Does the body editor show only on the **Fields** tab (not Comments/Activity)?
6. [ ] **Work-item create (the bug we fixed).** Click "New work item" a couple times — does it create cleanly each time (no 500)?
7. [ ] **Trigger Fields.** Open a trigger — is the Fields form full-height with NO Edit/Raw toggle (triggers have no body editor)?

## Status — FINAL (2026-05-31)
- Track A: **11/11 automated checks PASS, 0 confirmed bugs.**
- Track B (human): **all 7 checks PASS** — cockpit panel toggle (dropdown + Cmd-K), config slideover resize+persist, body-as-prompt label, NocoDB single-row header + body-editor-only-on-Fields, work-item create (the fixed 500), trigger Fields full-height — all confirmed working by Stefan.
- D1 (cockpit toggle, harness-deferred) → resolved by Track B human check: works.
- **Manifest is EMPTY of bugs. Phase 3 (FIX) skipped — nothing to fix.** → Completion.
