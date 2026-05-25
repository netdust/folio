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

- [x] **Bug #2 — Table header's sticky first column is missing its right border.**
  - Repro: load `/w/qa/p/demo/work-items`. The data rows' sticky first cell has computed `borderRightWidth: 1px` (correct). The header's sticky first cell has the same `border-r border-border-light` class string but computed `borderRightWidth: 0px` (broken).
  - Expected (per Task 3 in `tasks/todo.md`): both the header AND the data cells get a thin right border on the sticky first column, so the column boundary is consistent top-to-bottom.
  - Severity: **IMPORTANT** — visible inconsistency right at the top of the table: rows have a divider, header doesn't. Doesn't break a flow but undercuts the visual fix the task was supposed to ship.
  - Suspected root cause (do NOT fix yet — log only): button user-agent default + Tailwind `border-r` interaction; the data cell is a `div`, the header cell is a `button`, only the div picks up the 1px width.
  - Resolution: ☐ pending

### MINOR

- [x] **Bug #3 — Two a11y warnings about missing `Description` / `aria-describedby` on `DialogContent`.**
  - Repro: open a doc slideover → check the browser console.
  - Expected: zero a11y warnings.
  - Severity: **MINOR** — cosmetic console noise, not blocking. Pre-existing or introduced by this batch unclear.
  - Resolution: ☐ pending (likely defer)

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
