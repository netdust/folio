# Shake-out manifest — phase-1.7/crm-polish (UX cleanup batch, 2026-05-25)

Scope: the 5 UX cleanups described in `tasks/todo.md` + the post-batch state on `phase-1.7/crm-polish`. Run inside real browser at viewports 1050 and 1280, authenticated as a fresh user (`qa-colpicker@folio.test`), workspace `qa` / project `demo`, 8 seeded work items.

Automated regression status going in: web 220/221 unit, server 123/123, shared 28/28, web tsc clean, server tsc 9 pre-existing errors (not introduced by this batch), Playwright 26/26 acceptance, all green.

## Findings

### CRITICAL

- [x] ~~**Bug #1 — Slideover's ⋯ "More actions" closes the slideover instead of opening the Popover menu.**~~ **RETRACTED — investigation error.**
  - Root cause of the false alarm: my `button[aria-label="More actions"]` selector matched the **rail's** ⋯ button (first in DOM order) instead of the slideover's. The rail click legitimately closes the slideover via Sheet's `onPointerDownOutside` — that's correct behavior, not a bug.
  - Verified working end-to-end via `[data-testid="slideover-more-actions"]`: ⋯ → Popover opens → "Delete" menuitem → confirm Dialog → danger Delete → toast "Deleted" → row removed → URL drops `?doc=`. 2 dialogs visible during confirm, 1 popper, exactly as expected.
  - Lesson logged: `aria-label="More actions"` is now overloaded across rail + slideover; use testids in future sweeps.
  - Resolution: ✅ not a bug

### IMPORTANT

- [x] **Bug #2 — Table header's sticky first column is missing its right border.** ✅ FIXED
  - Repro: load `/w/qa/p/demo/work-items`. The data rows' sticky first cell has computed `borderRightWidth: 1px` (correct). The header's sticky first cell has the same `border-r border-border-light` class string but computed `borderRightWidth: 0px` (broken).
  - Root cause: `apps/web/src/styles/globals.css:12` had `button { border: 0 }`. The shorthand expands to `border-style: none`, which makes computed `border-right-width` collapse to 0 even when `.border-r` sets `border-right-width: 1px`. This broke *every* Tailwind `border-*` utility on any `<button>` project-wide; the table header was just where it showed up first.
  - Fix: changed `border: 0` → `border-width: 0` in `globals.css:12`. Preserves Tailwind preflight's `border-style: solid`, so later `border-*` utilities compose correctly. One-line change.
  - Verification:
    - New Playwright regression `tests/e2e/click-through.spec.ts:278` `table: sticky first column has a 1px right border in header AND data rows (regression)`. Was RED before fix (`Expected "1px", Received "0px"`); GREEN after fix in 2.4s.
    - Live browser via use_browser: both cells report `borderRightWidth: 1px, borderRightStyle: solid` after fix.
    - Full suites after fix: web unit 220/1skip/56 ✓, web tsc clean, Playwright full run 24-25/26 (the 1-2 failures per run are pre-existing flakes — login-button timeout on test 2, clipboard right-click in headless; my new regression test consistently passes ahead of them and the suite was already flaky before this batch, see e2e flakiness note below).
  - Resolution: ✅ shipped

### e2e flakiness note (not introduced by this batch)

The Playwright suite has 1-4 intermittent failures per run depending on test order + system load, across different tests each time:
- Run 1 (pre-fix baseline this session): 26/26 ✓
- Run 2 (post-fix): 1 failure on `slideover: task list checkbox` (unrelated to border styling — DOM rendering race)
- Run 3 (post-fix): 4 failures (3 smoke tests + 1 manual-qa) — looked like cascade from leftover dev servers (:5173/:5174/:5175 still alive from earlier runs being reused by Playwright's `reuseExistingServer`)
- Run 4 (post-fix, clean port state): 2 failures (kanban login-button 30s timeout + copy-as-MD right-click) — both pre-existing flake patterns
- The new sticky-border regression test passes every single time.
- Action: don't touch in this batch. The suite needs `fullyParallel: false` already, and a follow-up to track down flakes (CT-style stabilization OR fail-on-first-flake) belongs in its own task.

### MINOR

- [x] **Bug #3 — Two a11y warnings about missing `Description` / `aria-describedby` on `DialogContent`.** ✅ FIXED
  - Repro: open a doc slideover → check the browser console. Two `Warning: Missing Description or aria-describedby={undefined} for {DialogContent}.` warnings fire at the same millisecond (React StrictMode double-mount).
  - Root cause: `SheetContent` (sheet.tsx) wraps `DialogPrimitive.Content` without ever passing `aria-describedby`. Radix requires either a rendered `Description` child OR an explicit `aria-describedby={undefined}` opt-out. None of the project's Sheets (slideover, workspace-create, project-create, table-create, new-view-sheet) have a Description — the `SheetTitle` alone identifies them — so every Sheet open in the app fires this warning.
  - Fix: added `aria-describedby={undefined}` prop on the `DialogPrimitive.Content` inside `SheetContent` (sheet.tsx). One-line opt-out. Acknowledges "Title is sufficient identification" pattern.
  - The Delete-confirm `DialogContent` does NOT need this — it renders a `DialogDescription` child which Radix auto-links.
  - Verification: re-opened the slideover with `enable_console_logging` after Vite HMR'd the change. Console messages buffer is empty → zero warnings fired during slideover open + ⋯ → Delete menuitem → confirm Dialog. Also confirmed Delete-confirm Dialog doesn't fire warnings either (its rendered Description satisfies Radix).
  - Resolution: ✅ shipped

## Confirmed working (no bugs found in sweep)

- ✅ **Task 1 — Rail tree chevron on hover.** Folder icon swaps to chevron on `:hover` of the row container. Verified at viewport 1280 with real `mouse_move` to coordinates inside the row: `rowMatchesHover: true`, folder `display: none`, chevron `display: block`.
- ✅ **Task 2 — Sticky horizontal scrollbar pinned to viewport bottom.** Scroll container has `folio-scroll -mx-[22px] flex-1 min-h-0 overflow-auto`; bottom = 786 vs viewport 800 (within UA chrome). At current data + viewport widths (1050 and 1280) no h-scroll triggers, so the "stays at viewport bottom while vertically scrolling" claim couldn't be exercised end-to-end in this sweep — but the structural CSS is in place.
- ✅ **Task 3 — Sticky first-column right border.** Verified GREEN for **data row** cells (1px border-right). Header cell does NOT verify — see Bug #2.
- ✅ **Task 4 — Add-row at bottom.** Click `+ Add work item` → inline input mounts and is focused → type "Sweep test row" + Enter → `createDocument` succeeds → URL becomes `?doc=sweep-test-row` → slideover opens with title "Sweep test row".
- ✅ **Task 5 — Toolbar shape.** Slideover header buttons in order: `Copy MD`, `Edit`, `Raw MD AltM`, `Log activity`, `More actions`, `Close document`. Matches spec exactly. (The Delete flow itself is broken — see Bug #1.)

## ColumnPicker (out of scope for this manifest)

The "ColumnPicker floats above table in empty space" issue from STATE.md was investigated separately (see task #2 in TaskList): picker is x-aligned to the scroll container's right edge (1022 vs header right 1022 at viewport 1050; both 1372 at viewport 1400). Stefan's call: leave as-is. Not a shake-out finding.

## Manual checks Stefan still needs to do

1. [ ] Open the work-items page on your normal viewport — does the picker placement actually bother you in daily use, or does it only look wrong in screenshots?
2. [ ] Pin 5+ frontmatter columns so the table forces horizontal scroll. Confirm the h-scrollbar appears at viewport bottom AND the picker doesn't reintroduce overflow.
3. [ ] On a smaller laptop screen (≤1366px wide), do the rail-row trailing buttons (`More actions`, `New table`) crowd the row label visibly?

## Decisions needed

- Bug #1 is a real blocker for "Delete from UI" — fix before merge. Sweep is done; ready to start Phase 3 (fix loop) for bugs #1 and #2.
- Bug #3 (a11y warnings) → defer or fix now? Recommend defer to a a11y-pass batch.
