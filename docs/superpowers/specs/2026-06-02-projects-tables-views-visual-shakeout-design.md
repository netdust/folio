# Projects / Tables / Views — Visual Shakeout (Playwright e2e + screenshots)

**Date:** 2026-06-02
**Author:** Stefan (via Claude)
**Status:** Approved — ready to implement (do NOT run the shakeout yet)

## Goal

A repeatable Playwright e2e spec that drives **every interactive option** on the
projects / tables / views surfaces end-to-end, asserts the behaviour, and captures
a **named screenshot per option** into a folder a human eyeballs. Re-runnable in
CI; produces real visual artifacts.

This is a *visual verification* tool, not a pixel-regression suite. Each step
asserts a DOM consequence (sort applied, row added, chip present) and dumps a
labelled PNG. The human scrolls the PNGs to confirm each control renders and
behaves right.

## Decisions (locked during brainstorming)

1. **Form: Playwright e2e + screenshots.** Chosen over a human checklist or a
   one-shot Chrome-MCP sweep because it is repeatable and produces real artifacts.
   Prior Folio shakeouts pushed visual checks to a human Track B because the
   Chrome-MCP `.click()` misses Radix pointer handlers — Playwright's real
   `.click()` dispatches genuine pointer events, so Radix popovers/cmdk DO drive
   under Playwright.
2. **Screenshots are eyeball artifacts via `page.screenshot({ path })`, NOT
   `toHaveScreenshot()` baseline diffs.** No committed baselines, no cross-machine
   font flake. The test asserts behaviour; the PNG is for the human.
3. **One spec file** (not four-per-surface). One `bun run e2e` produces all
   artifacts in order.
4. **Scope: all four surfaces** — rail rows, table column+row ops, filters+kanban,
   views+Cmd-K.

## Architecture

- **New spec:** `apps/web/tests/e2e/shakeout-projects-tables-views.spec.ts`
- **New helpers in `apps/web/tests/e2e/fixtures.ts`:**
  - `shot(page, name)` — `page.screenshot()` into
    `test-results/shakeout/NN-name.png` with an auto-incrementing zero-padded
    counter so PNGs sort in run order.
  - `seedTable(page, wslug, pslug)` — drive the API to create a workspace +
    project + a handful of work items with frontmatter variety (priority,
    assignee, labels, status) so columns/filters/kanban have data to act on.
- **No infra changes.** Reuses the isolated alt-port stack
  (`playwright.config.ts`), `signUpFresh`, `createWorkspace`, `createProject`.
- **Each option = one `test.step()`**: perform → assert DOM consequence → `shot()`.
  Steps grouped per surface. Shared seeded workspace/project per surface so a
  failing step is isolated and named.

## Coverage — every option on the four surfaces

### 1. Rail rows (`rail-tree.tsx`)
- Project chevron expand / collapse
- Project click → navigate
- Project double-click rename (commit on Enter; escape cancels)
- Project ⋯ menu → delete
- Project `+` → new table
- Table chevron, click-navigate, rename, ⋯-delete, `+` → new view
- View click-navigate, rename, ⋯-delete

### 2. Table column + row ops (`table-*.tsx`, `column-*.tsx`)
- Header click → sort cycle asc → desc → none
- Header drag → reorder (mouse sequence; assert order changed)
- Column ⋯ menu → Rename / Change type / Hide / Delete (confirm dialog)
- Column picker (gear) → toggle a column off/on, pin a suggested column
- Add-column form (`+`) → walk the type selector, create a `select` with options
- Add-row footer → creates a work item
- Inline cell edit → edit a cell, assert persisted

### 3. Filters + Kanban (`filter-*.tsx`, `board-toolbar.tsx`, `kanban-view.tsx`)
- Add filter, each kind via the two-stage picker:
  status / priority / labels / assignee (text) / updated-since (date)
- Remove a filter chip (×)
- Kanban group-by dropdown → change grouping
- Kanban sort dropdown → change sort + toggle direction
- Kanban card drag between columns (mouse sequence; assert moved)

### 4. Views + Cmd-K (`new-view-sheet.tsx`, `command-palette.tsx`)
- New-view sheet → name + capture current filters/sort
- Switch views via rail → assert URL `?view=` hydrates filters
- Cmd-K open → switch project
- Cmd-K → switch workspace
- Cmd-K → create (new work item / new page)

## Handling fragile controls

Drag-reorder (columns) and kanban-card drag are the most fragile under any
headless harness. They are driven with Playwright's `dragTo()` / manual
`mouse.move` sequence and assert order changed. **Any option that still can't be
driven reliably is logged to a `Track B — needs human eyeball` list emitted at the
end of the run** (mirrors the existing manifest convention) rather than silently
passing or hard-failing the suite.

## Deliverables

- `apps/web/tests/e2e/shakeout-projects-tables-views.spec.ts`
- `shot()` + `seedTable()` helpers in `fixtures.ts`
- `tasks/shake-out-manifest-projects-tables-views.md` — how to run
  (`cd apps/web && bun run e2e shakeout-projects-tables-views`), where PNGs land
  (`test-results/shakeout/`), and the Track B residual list.

## Out of scope

- Pixel-regression / baseline diffing.
- Backend / API correctness (covered by server unit tests).
- Workspace-settings, agents, triggers surfaces (not projects/tables/views).
- Running the shakeout — build only; the run is a separate, user-initiated step.

## Risks / tradeoffs

- **Volume:** ~35–40 steps, ~300 lines. Kept tight via shared API setup.
- **Drag ops** are the fragile edge; degrade to Track B, never block.
- **Not regression-automated:** catches "control broken / renders wrong" by human
  eye, not automated drift detection — matches the "visually verified" ask.
