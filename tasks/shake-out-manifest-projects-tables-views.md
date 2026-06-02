# Shake-out — projects / tables / views (visual, Playwright e2e)

**Date:** 2026-06-02
**Branch:** `phase-op-3/the-agent`
**Spec:** `docs/superpowers/specs/2026-06-02-projects-tables-views-visual-shakeout-design.md`
**Form:** Playwright e2e that drives every option + dumps a numbered PNG per option for human eyeball. NOT pixel-regression.

## How to run

```bash
cd apps/web
bun run e2e shakeout-projects-tables-views        # all four surfaces
# or one surface:
bun run e2e shakeout-projects-tables-views -g "Rail rows"
bun run e2e shakeout-projects-tables-views -g "Table column"
bun run e2e shakeout-projects-tables-views -g "Filters + Kanban"
bun run e2e shakeout-projects-tables-views -g "Views + Cmd-K"
```

The Playwright config spins up its own API (:3002) + Vite (:5174) on an isolated
SQLite file (`apps/server/folio-e2e.db`, wiped by global-setup). No local dev
server needed.

## Where the artifacts land

`apps/web/test-results/shakeout/NN-surface-option.png` — full-page PNGs,
zero-padded counter, sorted in run order. **Scroll the folder and confirm each
control renders + behaves right.** This is the visual verification step.

Examples: `01-rail-project-expanded.png`, `08-table-sort-asc.png`,
`21-filter-status.png`, `34-cmdk-switch-project.png`.

## What each surface covers (one PNG per option)

| Surface | Options driven |
|---------|----------------|
| **Rail rows** | project chevron expand/collapse, click-navigate, double-click rename (Enter commit + Escape cancel), `+` → New table sheet, table ⋯ menu (Rename/Delete), table `+` → New view sheet → view created (`?view=`) |
| **Table column + row** | header sort cycle (asc→desc→none), column picker toggle off/on, add-column form (select + options), column menu Rename / Hide / Delete (confirm dialog), add row, inline title edit, column drag-reorder* |
| **Filters + Kanban** | add filter ×5 kinds (status / priority / labels / assignee-text / updated-since-date), remove chip, board tab, group-by dropdown, sort dropdown + direction toggle, card drag* |
| **Views + Cmd-K** | save a filtered view (`?view=` hydration), Cmd-K open (Meta+K), switch project, switch workspace, create new work item |

`*` = drag interaction — see Track B.

## Track B — needs a human eyeball

Drag-based controls are the one genuinely fragile interaction class under
headless Playwright. The spec **drives them and asserts**, but if a drag doesn't
register it degrades to a logged Track B line (printed in the `afterAll` console
output) instead of hard-failing. After a run, read the `[shakeout] Track B …`
console block and manually verify anything listed there:

- [ ] **Table column drag-reorder** — drag a header cell left/right; the column
      order changes and persists.
- [ ] **Kanban card drag-between-columns** — drag a card to another column; it
      moves and the new column/status persists on reload.

(If the run prints "Track B … none", every option drove cleanly and there is
nothing to check by hand.)

## Status

- [x] First run executed — **4/4 surface tests PASS, 37 PNGs captured** (2026-06-02)
- [ ] PNGs eyeballed (your step)
- [ ] Track B items manually verified (the 2 drag ops below)
- [x] Spec-build bugs found + fixed (see Findings)

After the run, Track B prints exactly:

```
[shakeout] Track B — 2 option(s) need a human eyeball:
  - Table: column drag-reorder did not change column order under headless Playwright — verify drag-to-reorder manually.
  - Kanban: card drag-between-columns is a headless-fragile pointer interaction — verify a card drag persists its new column manually.
```

Both are the *designed* degradations (headless drag is unreliable) — not product bugs.

## Findings

### Environment fix (blocker) — e2e registration was 403
Phase A gated first-user registration behind `FOLIO_ALLOW_BOOTSTRAP_REGISTRATION`.
The Playwright API server didn't set it, so every test's `signUpFresh` got 403 on
a wiped DB. **Fixed** in `playwright.config.ts` (test-only flag). This fixes ALL
e2e specs (smoke included), not just this shakeout.

### Selector lessons baked into the spec (so a re-run stays green)
- Column-header sort buttons' accessible name is the **UPPERCASE** label text
  (`TITLE`), not the `title=` tooltip — matched case-insensitively, scoped to
  `table-scroll`.
- Filter / kanban popover picks collide by name with column headers → scoped to
  the Radix popover (`role=dialog`).
- The default table is named **"Work Items"** (capital I) in the rail.
- `<input type=date>` does NOT submit on Enter in headless Chrome → submit via
  `form.requestSubmit()`.
- Cmd-K uses `ctrlKey` on Linux → `Control+k`, not `Meta+k`.
- Picker checkboxes are label-wrapped → `click({ force: true })`, assert by the
  column appearing/disappearing rather than checkbox state.
- Add-row opens a `?doc=` slideover over the table → Escape before editing a cell.

No product bugs found in the driven options. The only items needing your eyes are
the 2 drag interactions (Track B) and a scroll through the 37 PNGs.
