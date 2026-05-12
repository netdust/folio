# Phase 1 — Manual QA Checklist

Run on a fresh install in a real browser. Tick each box only after observing the described outcome. If anything fails, file a bug, fix it, re-run.

**Pre-flight:**

- Build the server: `bun --filter @folio/server dev` on port 3000.
- Build the web: `bun --filter @folio/web dev` on port 5173.
- Open Chrome / Firefox in an incognito / private window (so no prior session / cookies).
- Open DevTools Network tab to watch requests; Console for errors.

---

## Scenarios

### 1. Onboarding — workspace

- [ ] Visit `/`. Redirect to `/login?redirect=/`.
- [ ] Sign up with a fresh email + password. Land on `/`. See "Welcome to Folio" + "Create workspace" button.
- [ ] Click "Create workspace". Sheet opens. Type "Spring 26 Show" → slug auto-derives to `spring-26-show`.
- [ ] Click "Create workspace" in the form. Sheet closes. URL becomes `/w/spring-26-show`. Empty state visible.

### 2. Onboarding — project

- [ ] Inside the empty workspace, click "Create project". Sheet opens. Type "Gallery Ops" → slug auto-derives to `gallery-ops`.
- [ ] Submit. URL becomes `/w/spring-26-show/p/gallery-ops/work-items`. Empty work-items list visible. Rail shows the project. Frame tabs render: Work items / Board / Wiki.

### 3. List view — inline title edit

- [ ] Seed via curl: `curl -b cookies.txt -X POST http://localhost:3000/api/v1/w/spring-26-show/p/gallery-ops/documents -H 'Content-Type: application/json' -d '{"type":"work_item","title":"Fix login bug"}'`. Refresh.
- [ ] Row shows "Fix login bug" + status pill (empty / "no status") + relative time.
- [ ] Click the row title → inline input appears, text pre-selected.
- [ ] Type "Fix login (revised)" → Enter. UI updates immediately. Network shows PATCH 200.
- [ ] Reload the page. Title persists.

### 4. List view — inline status edit

- [ ] Click the status pill on the row. Popover opens with the four seeded statuses.
- [ ] Pick "In progress". UI updates instantly. Network shows PATCH 200.
- [ ] Reload. Status persists.

### 5. Slideover open / close

- [ ] Click the `↗` icon on the row. Slideover slides in from right. URL gains `?doc=fix-login-revised`.
- [ ] Press Escape. Slideover closes. URL clears.
- [ ] Open it again. Click the X button in the header. Same effect.
- [ ] Click outside the slideover (on the list area). Slideover closes. URL clears.

### 6. Slideover — frontmatter + body edits

- [ ] Open the doc. Edit title inline in the header (uses the same InlineEdit primitive).
- [ ] In the frontmatter form, type a value into `priority: high` (it should not exist yet — typing into the form's "Add field" surface; if no surface exists, set via curl: `PATCH ... -d '{"frontmatter":{"priority":"high","due_date":"2026-06-01","labels":["bug"]}}'` and reload).
- [ ] Open. Frontmatter form renders: priority chip, due_date picker, labels chip list.
- [ ] Change priority via inline edit. Change due_date. Add a label.
- [ ] In the body editor, type a heading `## Steps` and a paragraph. Wait 1s. Network shows PATCH 200 with `body`.
- [ ] Reload. All three edits persist.

### 7. Mode toggle — rich ↔ raw

- [ ] In the slideover, toggle to "Raw MD". Body shows raw markdown including headings as `##`. Frontmatter is NOT shown (it lives in the form above).
- [ ] Edit a line in raw mode. Wait 1s. Network shows PATCH 200.
- [ ] Toggle back to "Edit". Milkdown reflects the edit.
- [ ] Toggle Rich → Raw → Rich without typing. No PATCH fires.

### 8. Round-trip — the Phase 1 wedge

Use the fixture at `apps/server/src/__e2e__/fixtures/phase-1-frontend-roundtrip.md`. Seed via curl with `Content-Type: text/markdown`:

```bash
curl -b cookies.txt -X POST \
  http://localhost:3000/api/v1/w/spring-26-show/p/gallery-ops/documents \
  -H 'Content-Type: text/markdown' \
  --data-binary @apps/server/src/__e2e__/fixtures/phase-1-frontend-roundtrip.md
```

- [ ] Open the resulting work item. Milkdown renders the GFM table, the task list (second item checked), the code fence (the inner `---` block is NOT interpreted as YAML).
- [ ] Toggle to Raw MD. Confirm the body is byte-for-byte identical to the fixture's body (the section after the `---` frontmatter).
- [ ] Edit a line in raw mode. Toggle back to Edit. Milkdown reflects the edit.
- [ ] Reload. Confirm both views show the edited body. Confirm the frontmatter form still shows `priority`, `due_date`, `labels`, `estimate`, `agent`, and the nested `metadata` object.
- [ ] Right-click the row → Copy as Markdown. Paste into a text editor. Confirm byte-equality with the fixture's text after applying the same edit.

### 9. Kanban — drag-drop

- [ ] Seed a second work item. Switch to Board tab.
- [ ] Confirm both cards appear, grouped by status. Click a card → slideover opens.
- [ ] Drag a card from "Todo" into "In progress". Move 6px to activate drag. Drop. Card moves optimistically. Network shows PATCH 200.
- [ ] Reload. Card stays in "In progress".
- [ ] With DevTools → Network → Throttling: Offline, drag a card to another column. Card moves optimistically, then rolls back after the request fails. Toast appears.

### 10. Wiki — create + reparent

- [ ] Switch to Wiki tab. Empty state with "New page".
- [ ] Click "New page" → slideover opens for "Untitled". Edit title to "Parent". Close slideover.
- [ ] Click "New page" again → "Child". Close.
- [ ] Drag "Child" onto "Parent" (move 6px to activate). Child nests under Parent. Parent auto-expands.
- [ ] Reload. Nesting persists.
- [ ] Drag Parent onto Child → cycle prevented. Toast: "Cannot reparent a page onto its own descendant."
- [ ] To move Child back to root: open the slideover for Child, edit `parentId` via the frontmatter form to empty. Reload — Child is a root.

### 11. Copy-as-MD

- [ ] On the list view, right-click a row. Context menu appears with "Copy as Markdown".
- [ ] Click it. Toast: "Copied to clipboard".
- [ ] Paste into a text editor. Confirm: frontmatter block + body, format matches `GET /documents/:slug.md`.
- [ ] On the wiki tree, right-click a page → same. Toast + paste verified.
- [ ] Open the slideover. Click "Copy MD" in the header. Same effect.

### 12. Filter

- [ ] On work-items, click "+ Filter" → "Status" → "Todo". URL gains `?status=todo`. List shows only Todo rows.
- [ ] Click `×` on the chip. List restores. URL clears the param.
- [ ] Add two clauses: `status=todo` + `priority=high` (requires a pinned `priority` field — set via `POST /fields` if needed). Confirm AND-combined: only todo + high rows appear.
- [ ] Reload with the filter URL. List comes up filtered.

### 13. Cmd-K palette

- [ ] Press Cmd-K (Mac) or Ctrl-K (Linux/Windows). Palette opens.
- [ ] Type "new" → "New work item" and "New page" visible.
- [ ] Pick "New work item" → slideover opens for the new doc. Edit title.
- [ ] Cmd-K → type a doc title fragment → "Open document" group shows matches. Pick one → slideover opens.
- [ ] Cmd-K → "Switch workspace" → pick the only workspace (or seed a second to test). Navigates.
- [ ] Cmd-K → "Toggle theme". Palette closes. Theme flips.
- [ ] On `/login` (sign out first), Cmd-K does nothing. Palette is gated to authenticated routes.

### 14. Network failure rollback

- [ ] Open a doc. DevTools Network → Offline.
- [ ] Click title → inline edit → type something → Enter. Title updates optimistically.
- [ ] After ~5s the request fails. Title rolls back to original. Toast appears with error message.
- [ ] Back online. Re-edit. Saves cleanly.

---

## Acceptance gate

Phase 1 ships only when:

- All 14 scenarios above are ticked off.
- `bun test` passes (backend + new frontend Vitest suites — see Task 30).
- `bun run --filter @folio/web build` produces a working bundle.
- `bun run build:binary` (if present) produces a single binary that serves the bundle. If the binary build was deferred to Phase 4 polish, document that in the Phase 1 acceptance.
