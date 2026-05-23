# Folio — Tasks

Active task list for the current branch / session. Mark items off as you complete them. Add a `## Review` section at the bottom when a batch wraps up.

For phase-level checkboxes that survive across branches, see `docs/PHASES.md`. This file is short-lived working memory.

---

## Current branch: `phase-1.5/ux-polish`

### Gates before merging to main

- [x] Visual sign-off against canonical mockups (Stefan signed off on 2026-05-23 — "app looks good")
- [ ] Manual QA pass: `apps/web/tests/manual-qa-phase-1.md` (15 scenarios)
  - [x] Scenario 1 (e2e: passing)
  - [x] Scenario 2 (e2e: passing)
  - [ ] Scenario 3 — list view inline title edit (e2e scaffolded, selector TODO)
  - [ ] Scenario 4 — list view inline status edit (e2e scaffolded, selector TODO)
  - [ ] Scenario 5 — slideover open/close (e2e scaffolded, selector TODO)
  - [ ] Scenario 6 — slideover frontmatter+body (e2e scaffolded, selector TODO)
  - [ ] Scenario 7 — mode toggle rich↔raw (covered by unit `round-trip.test.tsx`)
  - [ ] Scenario 8 — round-trip the wedge (e2e scaffolded, selector TODO)
  - [ ] Scenario 9 — kanban drag-drop (e2e scaffolded, selector TODO)
  - [ ] Scenario 10 — wiki create+reparent (e2e scaffolded, selector TODO)
  - [ ] Scenario 11 — copy-as-MD (e2e scaffolded — Playwright contextmenu is tricky)
  - [ ] Scenario 12 — filter chip (e2e scaffolded, selector TODO)
  - [ ] Scenario 13 — Cmd-K palette (e2e scaffolded, selector TODO)
  - [ ] Scenario 14 — offline rollback (covered by optimistic-mutation unit tests; e2e too flaky)
  - [x] Scenario 15 — sign-up duplicate email (e2e: passing)
- [ ] Merge to `main`

### Bugs found this session — all fixed

- [x] **Sign-out missing** → `UserMenu` popover in the rail user row.
- [x] **"Create workspace" dead-end inside a workspace** → Sheet renders from the workspace layout.
- [x] **InlineEdit title corruption ("UntitledFirst task")** → `defaultEditing` now treats value as placeholder; empty commit reverts.
- [x] **Duplicate "Create workspace" / "New page" button names** → Sheet submits renamed to "Create"; empty-state CTAs renamed to "Create your first …".
- [x] **Wiki tree stale after title patch** → `useUpdateDocument` invalidates the broad list prefix, not just the slideover's listParams.
- [x] **Kbd hint hardcoded `⌘K` / `⌥M` on Linux** → `modKeyHint()` + `altKeyHint()` in `lib/platform.ts`.
- [x] **"1 pages" pluralization** → singular/plural switch in sub-meta.
- [x] **Duplicate `aria-label="Open document"` / `"Document title"`** → Interpolated with `doc.title`.
- [x] **Alt+M kbd hint not bound** → Window-level listener in DocumentSlideover.
- [x] **Task list items had no checkbox** → Editor CSS draws checkbox via ::before/::after (toggle interactivity deferred to Phase 3).
- [x] **Filter chips ignored server-side** → Server list handler reads flat `?status=&assignee=&updated_since=` params.
- [x] **+ Filter button "did nothing"** → Chip/ChipAdd now `forwardRef` so Radix `asChild` can attach its ref.

### Other open threads (low priority — don't block merge)

- [ ] Decide what to do with `.zed/` and `labeled-actual.png` at repo root (commit, .gitignore, or leave)
- [ ] Lift `.skip` on the 10 scaffolded manual-qa e2e tests once a selector strategy is settled (add `data-testid` on critical row/cell components, or rely on aria-labels after auditing).
- [ ] **List column-header sort is wired only on the client** — clicking Title/Status/Updated writes `?sort=…&dir=…` to the URL but the server's documents list handler ignores those params. Either implement server-side sort (matching the filter wiring pattern) or remove the sortable visual affordance.
- [ ] **Milkdown task checkbox toggle** — the checkbox visually reflects `data-checked` but clicking doesn't toggle. Requires ProseMirror transaction-level access; defer to Phase 3 where slash commands + AI need the same surface.

---

## Queued for next branch (pre-Phase-2 cleanups)

Per auto-memory `project_main-tip-and-pre-phase-2-cleanups` — three items queued before Phase 2 kicks off. Surface them when picking a new branch.

---

## Review

### 2026-05-24 — exploratory + bug-fix batch (sessions of 2026-05-23 → 2026-05-24)

**Branch:** `phase-1.5/ux-polish`. Final tip after this batch: see `git log -1`.

**Work done this batch:**
- 4 exploratory click-through passes (slideover · wiki · Cmd-K · editor · filter) driving the app via Chrome DevTools MCP as a real user, not API shortcuts.
- 12 distinct bugs fixed (see checklist above) — all with click-through e2e regression coverage.
- Playwright scaffold added: `apps/web/playwright.config.ts`, `apps/web/tests/e2e/{global-setup,fixtures,smoke,manual-qa,click-through}.{ts,spec.ts}`. Isolated DB + alt-port stack at `apps/server/folio-e2e.db`.
- Server-side filter wiring (`?status=`, `?assignee=`, `?updated_since=`) + 4 new server tests + `seedProjectDefaults` opt-in on the test harness.
- Token cleanup from review pass: dropped `--color-board-col` / `--ring-color`, promoted `--color-nav-active`, named `.input-focus` utility, single subtle `--ring`.
- 9 lessons captured in `memory/lessons.md`.

**Tests at batch end:** 134 web unit · 81 server unit · 16 active e2e · 10 e2e skipped (selector work).

**Open gates before merging to main:**
- 12 of 15 manual-qa scenarios still pending (3 active in e2e + the editor/wiki/filter regressions cover much of 6, 8, 9, 10, 12 indirectly — but the original spec scenarios are still `[ ]`).
- Visual sign-off: ✅ given on 2026-05-23.
- Merge to main: pending.

**Recommended next session:** either (a) finish lifting the 10 `.skip`s in manual-qa.spec.ts (add `data-testid` on rows + selectors), or (b) tackle Phase 1.5 time-aware views (timeline + This Week dashboard) since the polish branch is now in good shape and the unticked manual-qa boxes have e2e proxies.
