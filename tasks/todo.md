# Folio — Tasks

Active task list for the current branch / session. Mark items off as you complete them. Add a `## Review` section at the bottom when a batch wraps up.

For phase-level checkboxes that survive across branches, see `docs/PHASES.md`. This file is short-lived working memory.

---

## Current branch: `phase-1.7/crm-polish` — UX cleanup batch (2026-05-25)

Five independent UX cleanups discovered during Stefan's manual QA pass. All client-side except (5), which uses the existing backend DELETE.

### Decisions locked

- **Rail chevron:** Swap leading icon → chevron on hover. Non-expandable rows keep their icon always.
- **Delete:** Confirm dialog (existing `dialog.tsx`) before delete.
- **Add row:** Empty + row at the bottom → inline-editable title in the row → on commit, create the doc + open slideover for the rest.
- **Horizontal scrollbar:** Sticky inside the main scroll area, not a fixed overlay.
- **Slideover toolbar:** Visible = Copy MD + Edit/Raw + Activity. ⋯ menu = Delete (+ room to grow). Body header loses LogActivityButton + ModeToggle.

### Tasks

- [ ] **Task 1 — Rail tree: chevron on hover, replacing leading icon**
  - `apps/web/src/components/shell/rail-tree.tsx:46-92`
  - For expandable items, render the leading icon slot with two siblings: icon (default) + chevron (`hidden group-hover/row:inline-grid`). The icon gets `group-hover/row:hidden`. The wrapping element is a button when expandable, otherwise a non-interactive span. Keep `aria-expanded`, `aria-label`, `data-testid="rail-tree-chevron-${item.id}"` on the button.
  - Drop the old standalone chevron column (lines 55-69) and the empty placeholder span (lines 70-72) when there are no children — the icon itself takes the slot now.
  - **Unit test:** extend `rail-tree.test.tsx` — `expandable` node: chevron testid exists, clicking it flips `aria-expanded`. `non-expandable` node: no chevron testid.

- [ ] **Task 2 — Table: sticky horizontal scrollbar pinned to viewport bottom**
  - `apps/web/src/components/table/table-view.tsx:297-339`
  - Refactor the scroll container so the `overflow-x-auto` div wraps both header + rows AND is `sticky bottom-0` within MainFrame's vertical scroller. The visible result: when the rows extend beyond the viewport vertically, you can still see + drag the horizontal scrollbar at the bottom of the visible area.
  - The MainFrame's vertical scroller (`main-frame.tsx:45`) is left alone — TableView simply pins its own horizontal-scroll wrapper to the bottom of its bounding box. Use `sticky bottom-0 bg-content` on the inner scroll strip to glue the scrollbar to the viewport edge.
  - **Unit test:** in `table-view.test.tsx`, assert the scroll wrapper has the `sticky` + `bottom-0` + `overflow-x-auto` classes.

- [ ] **Task 3 — Table: thin right border on sticky first column**
  - `apps/web/src/components/table/table-cell.tsx:40`, `apps/web/src/components/table/table-header.tsx:113`
  - Append `border-r border-border-light` to the sticky wrapper in both files.
  - **Unit test:** `table-cell.test.tsx` — sticky cell has `border-r` className, non-sticky cell does not.

- [ ] **Task 4 — Table: add-row at bottom**
  - New file: `apps/web/src/components/table/table-add-row.tsx`. Site of call: `table-view.tsx:323-337`.
  - Render after the data rows, only when `filteredDocs.length > 0`. Same grid template as TableRow so columns align. First column = `+` icon + clickable area that activates the inline title input. On commit:
    1. `createDocument({ type: 'work_item', title })`.
    2. Navigate to `?doc=<slug>`.
  - Use the existing `useCreateDocument` hook + `formatApiError` for the error path. Reuse `InlineEdit` with `defaultEditing` semantics — on click of the row, mount an `InlineEdit` with `defaultEditing` (the existing primitive). For empty commit / blur: revert to the static `+ Add work item` placeholder.
  - **Unit test:** `table-view.test.tsx` (or a dedicated `table-add-row.test.tsx`): render TableView with mocked API, find the add-row, simulate typing + Enter, assert `createDocument` called with the typed title and `navigate` called with `search.doc = <created slug>`.

- [ ] **Task 5 — Slideover: action toolbar + ⋯ menu with Delete**
  - `apps/web/src/components/slideover/document-slideover.tsx:60-98, 200-208, 240-246` + lift `mode` state up.
  - Header right-side: Copy MD button → ModeToggle → LogActivityButton → vertical divider → ⋯ Popover (RowMenu-style — destructive `Delete` item) → Close.
  - Article body header: drop LogActivityButton + ModeToggle. Keep slug pill left.
  - Lift `mode` state and the `Alt+M` window listener from `SlideoverBody` (lines 163-175) up to `DocumentSlideover`. Pass `mode` + `setMode` down to `SlideoverBody`.
  - Delete flow: `Delete` menu item → `<Dialog>` (existing `ui/dialog.tsx`) with title "Delete this document?" + body `Delete "{title}"? This cannot be undone.` + Cancel + danger Delete button. On confirm: `useDeleteDocument(wslug, pslug).mutateAsync(doc.slug)` → toast + close slideover.
  - **Unit test:** extend `document-slideover.test.tsx` — assert toolbar shape (Copy MD + ModeToggle + LogActivityButton + ⋯). Open ⋯, click Delete: dialog opens. Cancel: dialog closes, no mutation. Confirm: `useDeleteDocument` mutation called with the doc's slug, slideover closes.

### Phase complete checklist (testing-workflow gate)

- [ ] All 5 task-level unit tests green
- [ ] `cd apps/web && bun run test` full suite green
- [ ] `cd apps/server && bun test` still 116 / 116 (no backend changes)
- [ ] `cd packages/shared && bun test` still 28 / 28
- [ ] TS clean across all three apps
- [ ] `bun dev` boots clean; no console errors on the work-items page

### Smoke test (manual, after green)

- [ ] Rail: hover a workspace row → leading icon swaps to chevron, click expands. Wiki leaf keeps its icon, no chevron on hover.
- [ ] Table: scroll horizontally — scrollbar stays at viewport bottom while vertically scrolling rows.
- [ ] Table: sticky first column has thin right border against the scrolling columns.
- [ ] Table: bottom row = empty + row. Click → type "New" → Enter → slideover opens for the new doc. After closing, the new row appears in the list.
- [ ] Slideover: header has Copy MD + Edit/Raw + Activity + ⋯ + ✕. ⋯ → Delete → confirm dialog → Delete → toast + slideover closes + row gone from table.

---

## Gates before merging to main (Phase 1.7 batch — carried over)

- [ ] Manual QA pass on Phase 1.7 + the UX cleanups in this todo
- [ ] Merge `phase-1.7/crm-polish` → `main`

---

## Queued for next branch (pre-Phase-2 cleanups)

Per auto-memory `project_main-tip-and-pre-phase-2-cleanups` — three items queued before Phase 2 kicks off. Surface them when picking a new branch.

---

## Review

(Add a review block here when this batch wraps.)
