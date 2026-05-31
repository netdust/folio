# Shake-out manifest — Relation fields + backlinks

_Date: 2026-05-31 · Branch: `phase-3.x/board-view` · Feature commits `b3fb951..041e68f`_

## Environment
- Stack: Bun/TS monorepo. API `@folio/server` on **:3001** (NOT 3000 — `.env` sets PORT=3001; CLAUDE.md's `bun --filter=server dev` is also wrong, the package is `@folio/server`, script `bun run --hot src/index.ts`). Web `@folio/web` on Vite :5173, proxies `/api` → :3001.
- No Codeception (Node project) → unit suites + live API sweep + browser-driving.

## Phase 1 Track A — Automated sweep (live server + real SQLite)

All against a running instance with seeded data (registered user → workspace → project → docs).

| # | Check | Expected | Actual | Result |
|---|---|---|---|---|
| A1 | API boots, auth middleware live | 401 on unauth `/workspaces` | 401 UNAUTHENTICATED | ✅ |
| A2 | Create relation field (single, `table:<id>`) via POST `/fields` | 201, options persisted | 201, `["table:…","single"]` | ✅ |
| A3 | Create relation field (multi, `wiki`) | 201 | 201, `["wiki","multi"]` | ✅ |
| A4 | PATCH doc: single `"[[ada-lovelace]]"` + multi `["[[known-issues]]"]` | 200, frontmatter persisted | 200, exact shapes stored | ✅ |
| A5 | Backlinks for single-link target (`ada-lovelace`) | returns holder `login-bug` | `[{slug:login-bug,…}]` | ✅ |
| A6 | Backlinks for multi-array target (`known-issues`) | returns holder (array-element match) | `[{slug:login-bug,…}]` | ✅ — proves `json_each` array match on real data |
| A7 | Backlinks for non-linked doc (`bob-martin`) | empty | `[]` | ✅ |
| A8 | Backlinks for nonexistent slug | 404 | 404 | ✅ |
| A9 | Slug immutability: retitle holder | slug unchanged, title changed | slug stayed `login-bug`, title updated | ✅ |
| A10 | Inbound backlink survives retitle | still resolves, shows new title | resolves, new title | ✅ |
| A11 | Negative validation: bad cardinality | 422 | 422 | ✅ |
| A12 | Negative validation: missing options | 422 | 422 | ✅ |
| A13 | Table render — broken-link styling absent | no `.line-through` in table | `struckThrough: []` (Finding-9 fix holds) | ✅ |

**Track A verdict: clean. The entire server wire + the Finding-9 table-styling fix are proven live.**

## Phase 1 Track B — Manual checks needed (human)

Automated browser-driving hit harness friction (viewport resets on navigate, title-cell click triggers inline-edit instead of slideover, `?doc=` URL normalized away) — these are TEST-HARNESS limitations, not observed product defects. The unit suites cover the slideover relation editing + backlinks panel (field-renderer.test.tsx, backlinks-panel.test.tsx, relation-picker.test.tsx — all green), and the backlinks DATA is proven live (A5/A6). What remains is **visual confirmation in a real browser**:

Seeded test data lives in workspace **Netdust → project Client Website**: field `related_to` (single→work-items), docs `SHAKEOUT Holder Doc` (links to → `SHAKEOUT Target Doc`). (Will be cleaned up — see note; re-seed via the API if needed.)

1. [ ] Add the `related_to` column to the table view (column picker) → the Holder row's cell shows a **resolved chip "SHAKEOUT Target Doc"** (a normal chip, NOT struck-through/mono).
2. [ ] Open the Holder doc's slideover → the `related_to` field shows the linked doc as a chip + an "add link" affordance; clicking it opens the scoped picker listing work-items.
3. [ ] In the slideover, add a second/different link (single → replaces; try a multi field → appends); remove a chip → clears/filters correctly.
4. [ ] Open the **Target** doc's slideover → a **"Linked from"** panel lists "SHAKEOUT Holder Doc"; clicking it navigates to the holder.
5. [ ] Create a relation field through the **Add column** UI (pick Relation → target select shows Wiki + tables, cardinality select) → saves and the column appears.
6. [ ] Point a link at a doc, then delete that doc → the relation renders as **struck-through unresolved** `[[slug]]` (and does not crash the row).

## Phase 2 — Bug clusters

**Zero bugs found in the sweep.** No CRITICAL / IMPORTANT / MINOR defects surfaced in Track A. The whole-diff review earlier this session already caught + fixed the one integration defect (Finding 9: table cells rendered valid links as broken — fixed in `041e68f`, re-verified clean here in A13).

## Phase 3 — Fix

N/A — empty manifest (Track A). Pending only the human Track-B visual confirmation above.

## Notes / non-blocking observations
- **CLAUDE.md dev-command drift** (MINOR, doc-only): "Build & Run" lists `bun --filter=server dev` / `bun --filter=web dev` — the filter names are `@folio/server` / `@folio/web`. Worth a one-line CLAUDE.md fix in a future chore commit (not part of this feature).
- **Test-data cleanup done:** the `SHAKEOUT Holder/Target Doc` + `related_to` field seeded into Netdust → Client Website for the browser sweep were DELETED afterward (all 204). The `shakeout-ws` workspace under the throwaway `shakeout@folio.test` user is isolated and left as-is (harmless).
- **Incidental delete-path check (A14, ✅):** deleting the two linked docs via the API returned 204 with no error — the delete path over docs that participate in relations works (no cascade attempted, as designed; dangling links left in frontmatter per spec). Partially covers Track-B #6's "delete a linked doc doesn't crash" — the server side is confirmed; the unresolved-render visual is still a manual check.
