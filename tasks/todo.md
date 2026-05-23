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

### Bugs found this session — both fixed in commit (to be made)

- [x] **Bug 1:** Can't open account / sign out → Added `UserMenu` popover in the rail user row.
- [x] **Bug 2:** "Create workspace" from inside a workspace dead-ended → Now opens the `WorkspaceCreate` sheet over the current layout.

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

_(none yet — fill in when a batch wraps)_
