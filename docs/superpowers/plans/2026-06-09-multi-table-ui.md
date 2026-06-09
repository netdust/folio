# Multi-Table Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a non-default table (e.g. `bugs`, `roadmap`, `docs`) actually open in the browser and render its OWN documents, statuses, fields, and views — instead of the rail silently showing the `work-items` table for every table click.

**Architecture:** The server is already fully table-aware: every data endpoint is mounted twice — once table-scoped at `/w/:wslug/p/:pslug/t/:tslug/{documents,statuses,fields,views}` and once project-scoped (`…/p/:pslug/{documents,statuses,…}`) where `getTable(c)` resolves the project's DEFAULT `work-items` table as a fallback (`apps/server/src/app.ts:99-110`, `middleware/scope.ts:111-136`). The **web frontend calls only the project-scoped fallback for documents/statuses/views**, so it always reads/writes the default table — even though `useFields` already calls the `/t/:tslug/fields` variant (proof the pattern works). This plan threads a real `tslug` through (a) the web API hooks + their react-query keys, (b) a new `/t/:tslug` route pair mirroring `work-items.tsx` + `board.tsx`, and (c) the rail-click handlers in `w.$wslug.tsx` that currently DISCARD `_tslug`. It introduces a single web-side `DEFAULT_TABLE_SLUG` constant + a `useCurrentTslug()` resolver so `'work-items'` stops being re-hardcoded.

**Tech Stack:** TypeScript, React, TanStack Router (file-based routes), react-query, Vitest (unit, `npx vitest run` in `apps/web`), Playwright (e2e, `apps/web/playwright.config.ts`).

---

## Class & gate decisions (planner's record)

**Class A** — new user-facing feature, multi-task. Stage 0 brainstorm skipped: the feature shape is fully specified and ground-truthed against source; no open design questions remain.

**Gates that FIRE:**
- **1b architecture-invariants** — touches invariant **16** (board-view persistence) + invariant **6** (web data-access react-query keys) + introduces a NEW web convergence point (`DEFAULT_TABLE_SLUG` + current-tslug resolution). See `## Architecture invariants touched`. (skill: `architecture-invariants`, loaded.)
- **1g feature-acceptance** — a user-facing routing/render flow with empty/denied/deep-link/concurrent/boundary/mid-flow-failure edges. See `## Acceptance flows`. (skill: `feature-acceptance`, loaded.)

**Gates that DO NOT fire (considered, not skipped):**
- **1a threat-modeling — DOES NOT FIRE.** This is **display + client-side routing only.** No new untrusted input is parsed (the `tslug` URL segment is validated server-side by the existing `resolveTable` middleware, which 404s an unknown slug — `scope.ts:131-136`). No auth/session/token surface changes — the server's existing `requireScope`/`requireResource`/`canSeeProject` guards on the `t/:tslug` routes serve the data unchanged (a user who can't see the project already gets a 403/404 from the server; the client just renders that error via `formatApiError`). No outbound requests to user-supplied URLs, no BYOK, no crypto. The only "input" is a slug the user navigates to, and the server is the authority on whether it resolves. **Explicitly considered and ruled out — not an oversight.**
- **API/boundary design (`designing-apis`) — DOES NOT FIRE.** No new server API or boundary is designed; the table-scoped endpoints already exist and are consumed by `useFields` today. This plan only points more web hooks at endpoints that already ship.

**Stage 1c ground-truthing (premises verified against source BEFORE planning):**
1. ❌ **"TableView is prop-ready" — HALF FALSE.** `TableView`/`KanbanView` accept `tslug` and forward it to `useFields`/`useCreateField`/`useUpdateField`/`useDeleteField` ONLY (`table-view.tsx:85,102-104`; `kanban-view.tsx:52`). The load-bearing data hooks — `useDocuments` (83), `useStatuses` (84), `useViews` (97), `useUpdateView` (101), and the hardcoded `type:'work_item'` create (220) — are NOT table-aware. The component is prop-threaded but its data layer is not. **This is the real gap and the largest task cluster.**
2. ❌ **"the api lib takes a tslug" — FALSE for the data hooks.** `useDocuments`/`useStatuses`/`useViews`/`useUpdateView` hit `/w/${wslug}/p/${pslug}/{documents,statuses,views}` with NO `t/${tslug}` segment (`documents.ts:84`, `statuses.ts:20`, `views.ts:24,49,80`). Only `useFields` calls `/t/${tslug}/fields` (`fields.ts:38`). Their react-query keys are project-keyed (`statusesKeys.list(wslug,pslug)`, `viewsKeys.list(wslug,pslug)`, `documentsKeys.list(wslug,pslug,params)`) — only `fieldsKeys` carries tslug (`fields.ts:30`).
3. ✅ **Server is table-aware.** `app.ts:99-105` mounts `tScope` (statuses/fields/views/documents) under `pScope.route('/t/:tslug', tScope)`; `app.ts:107-110` mounts the same routers project-scoped as the fallback. `getTable(c)` returns the `:tslug` table or the default `work-items` table (`scope.ts:111-136`). `DEFAULT_TABLE_SLUG = 'work-items'` (`seed-project-defaults.ts:12`) is the server convergence point.
4. ✅ **`rail-tree.ts` already threads `tslug` correctly** through every handler (`onTableClick(pslug,tslug)`, `onViewClick(pslug,tslug,viewId,type)` — `rail-tree.ts:44,48,107,121`). The rail tree is NOT the gap.
5. ❌ **The gap is the CONSUMER in `w.$wslug.tsx`** (`onTableClick: (pslug, _tslug) => navigate('…/work-items')` — line 206; `onViewClick` drops `_tslug` — line 212), which discards the slug the rail correctly supplies.
6. ✅ **Sibling-site literals** of `useFields(wslug, pslug, 'work-items')`: `document-slideover.tsx:572`, `list-view.tsx:51`, `new-view-sheet.tsx:42`; route literal `new-view-sheet.tsx:105`. `board-controls.tsx:19` takes `tslug` but its `useViews`/`useUpdateView` (21,23) are project-scoped (same gap).

---

## Architecture invariants touched

This plan was checked against `ARCHITECTURE-INVARIANTS.md` (root). It touches three convergence points and proposes one new one.

| Invariant | How this plan touches it | What the implementer must NOT do (the bypass = bug) |
|---|---|---|
| **16 — Board-view persistence** (`kanban-view.tsx` `onDragEnd` → `documents` PATCH; `board-controls.tsx` `onGroupByChange`/`onSortChange` → `views` PATCH) | The board's manual `board_position` write and its group-by/sort view write MUST land on the **active table's** documents/views. Today `KanbanView`'s `useUpdateView`/`useUpdateDocument` and `BoardControls`' `useUpdateView` are project-scoped → they write the **default `work-items` view/docs even when the board is showing `bugs`.** Tasks 3 + 9 re-scope these to `tslug`. | Do NOT leave the board's `useUpdateView`/`useUpdateDocument`/`useDocuments` project-scoped while the route is table-scoped — a `bugs` board would silently persist group-by/sort/position onto `work-items`' view + docs (data written to the wrong surface). Keep the persist-whenever-`activeView`-resolved trigger rule (no re-introduced `?view=` gate). |
| **6 — Web data-access (one `client` + per-resource key factories)** | `statusesKeys`, `viewsKeys`, `documentsKeys` are project-keyed; switching tables under the same project would collide cache entries and NOT refetch (the new table reads the old table's cached rows). This plan adds `tslug` to those key factories so each table has a distinct cache entry — mirroring `fieldsKeys` (`fields.ts:30`), which already does this correctly. | Do NOT add a bare `client.get('…/t/${tslug}/…')` with a project-scoped key (`['statuses', wslug, pslug]`) — the key MUST include `tslug` or table switches won't invalidate. Do NOT hand-build a literal key that mirrors the factory (invariant 6's known soft-spot warning). |
| **8 — Live updates (SSE invalidates by key)** | Adjacent: SSE-driven `invalidateQueries` must invalidate the table-scoped key. Covered automatically once Task 1's keys carry `tslug` AND the prefix-invalidation in `useCreateDocument`/`useUpdateDocument` (`documents.ts:110`, and the update hook) is widened to the table-scoped list prefix. | Do NOT leave a create/update mutation invalidating `[...documentsKeys.all, wslug, pslug, 'list']` while reads use a `tslug`-keyed list — an optimistic create in `bugs` would not refetch (`bugs` list never invalidates). Task 1 aligns the invalidation prefix with the new key shape. |

### NEW convergence point proposed (author into `ARCHITECTURE-INVARIANTS.md` at execution, Task 11)

> **18 — Current-table resolution & the default-table slug are decided in ONE web place.** The literal `'work-items'` is the seeded default table (`DEFAULT_TABLE_SLUG`, server `seed-project-defaults.ts:12`). On the web it is currently re-hardcoded in ≥5 sites. Converge it on `apps/web/src/lib/default-table.ts` (`DEFAULT_TABLE_SLUG = 'work-items'`) + a `useCurrentTslug()` hook (reads the route's `tslug` param, falling back to `DEFAULT_TABLE_SLUG`). A component that hardcodes the string `'work-items'` instead of importing the constant — or re-derives "which table am I on" from the path instead of `useCurrentTslug()` — is a bug. *(This is the structural twin of the server's `DEFAULT_TABLE_SLUG`; the back-compat `/work-items` route resolves to this same constant.)*

This invariant note is authored in Task 11 (the close-out task) once the constant + hook exist and have consumers.

---

## Default-table routing decision (locked)

**Decision: keep the existing `/work-items` + `/board` routes for the default table (back-compat) AND add `/t/:tslug` + `/t/:tslug/board` for any table including `work-items`.** Rationale:
- Existing deep-links, bookmarks, the Cmd-K palette, and `onProjectClick` (which lands on `/work-items`) keep working unchanged — zero migration risk.
- The new `/t/:tslug` route is the general path; `work-items.tsx`/`board.tsx` become thin shims that render the same component with `tslug={DEFAULT_TABLE_SLUG}`.
- The rail's `onTableClick`/`onViewClick` route the DEFAULT table to `/work-items` (back-compat) and any NON-default table to `/t/:tslug`. This keeps the highlight/active-row logic (which keys on `viewId`/`isWiki`, not the route path) intact and avoids a flash-migration of every existing link.

The `useCurrentTslug()` hook makes both routes resolve to the right slug, so the rendered components never branch on which route they came from.

---

## File Structure

| File | Create / Modify | Responsibility |
|---|---|---|
| `apps/web/src/lib/default-table.ts` | **Create** | `DEFAULT_TABLE_SLUG = 'work-items'` constant + `useCurrentTslug()` hook (reads `tslug` route param, defaults to the constant). The single web convergence point for "which table." |
| `apps/web/src/lib/api/statuses.ts` | Modify | `statusesKeys.list(wslug,pslug,tslug)` + `useStatuses(wslug,pslug,tslug)` → `…/t/${tslug}/statuses`. |
| `apps/web/src/lib/api/views.ts` | Modify | `viewsKeys.list(wslug,pslug,tslug)` + `useViews`/`useCreateView`/`useUpdateView`/`useDeleteView` all take + thread `tslug` → `…/t/${tslug}/views`. |
| `apps/web/src/lib/api/documents.ts` | Modify | `documentsKeys.list(wslug,pslug,tslug,params)`; `useDocuments`/`useCreateDocument`/`useUpdateDocument` take `tslug` → `…/t/${tslug}/documents`; align invalidation prefix to the tslug-keyed list. |
| `apps/web/src/routes/w.$wslug.p.$pslug.t.$tslug.tsx` | **Create** | Table-grid route; `validateSearch` identical to `work-items.tsx`; renders `<TableView wslug pslug tslug={Route.useParams().tslug} />`. |
| `apps/web/src/routes/w.$wslug.p.$pslug.t.$tslug.board.tsx` | **Create** | Kanban route; renders `<KanbanView … tslug={tslug} />`. |
| `apps/web/src/routes/w.$wslug.p.$pslug.work-items.tsx` | Modify | Render `<TableView … tslug={DEFAULT_TABLE_SLUG} />` (shim, no behavior change). |
| `apps/web/src/routes/w.$wslug.p.$pslug.board.tsx` | Modify | Render `<KanbanView … tslug={DEFAULT_TABLE_SLUG} />` (shim). |
| `apps/web/src/components/table/table-view.tsx` | Modify | Pass `tslug` to `useDocuments`/`useStatuses`/`useViews`/`useUpdateView`/`useUpdateDocument`; create-doc still `type:'work_item'` (unchanged — `type` is doc-kind, the table is scoped by the URL). |
| `apps/web/src/components/views/kanban-view.tsx` | Modify | Same re-scoping; `onDragEnd`'s document PATCH + `useUpdateView` are tslug-scoped (invariant 16). |
| `apps/web/src/components/kanban/board-controls.tsx` | Modify | `useViews`/`useUpdateView` take `tslug` (invariant 16, group-by/sort persist target). |
| `apps/web/src/routes/w.$wslug.tsx` | Modify | `onTableClick`/`onViewClick`/`onNewView` STOP discarding `_tslug`: route default table → `/work-items`\|`/board`, non-default → `/t/:tslug`\|`/t/:tslug/board`, threading `params: { tslug }`. Populate `currentRoute.tslug` from the path. |
| `apps/web/src/components/views/list-view.tsx` | Modify | `useFields(wslug,pslug,'work-items')` → `useFields(wslug,pslug,useCurrentTslug())`. |
| `apps/web/src/components/views/new-view-sheet.tsx` | Modify | Same `useFields` fix + route literal `/work-items` → tslug-aware `to`. |
| `apps/web/src/components/slideover/document-slideover.tsx` | Modify | `useFields(wslug,pslug,'work-items')` → `useCurrentTslug()`. |
| `ARCHITECTURE-INVARIANTS.md` | Modify | Author invariant 18 (Task 11). |

---

## Acceptance flows

> Driven at `/shakeout` by the `feature-acceptance` skill. UI flows MUST be driven through the real browser (Playwright spec → else `superpowers-chrome` `use_browser` against the dev server). Each flow enumerates the six edge classes; an excluded edge states why.

**Setup fixture for all flows:** a project `P` with TWO tables — the seeded `work-items` AND a `bugs` table (distinct statuses, ≥1 field, ≥1 doc with a status that does NOT exist in `work-items`, so a wrong-table render is visually unambiguous). The MCP/API creates this correctly today (verified live).

### Flow 1 — Click a non-default table in the rail → its own data renders

| Edge class | Case | Expected |
|---|---|---|
| **Happy path** | Expand `P` in the rail, click the `bugs` table row. | URL becomes `/w/<w>/p/<P>/t/bugs`; the grid shows `bugs`' documents and `bugs`' statuses/fields — NOT work-items' rows. The `bugs`-only status appears in the status column/filter. |
| **Empty / zero state** | `bugs` table has zero documents. | Empty state renders ("No documents yet" / create CTA), NOT a spinner-forever and NOT work-items' rows. Creating a doc here lands it in `bugs` (verify via API: the new doc's `table_id` = bugs). |
| **Denied actor** | A user with NO `project_access` to `P` navigates to `/t/bugs`. | Server 403/404 surfaces via `formatApiError` as a clean error panel, not a blank grid or a leak of bugs' rows. (Server-enforced — unchanged; we only render its error.) |
| **Wrong-order / re-entry** | Paste `/w/<w>/p/<P>/t/bugs` directly into the address bar (deep-link, no rail click). | Same render as the happy path — the route resolves `tslug` from the param, no rail-click state required. |
| **Concurrent / double** | Rapidly click `work-items` then `bugs` then `work-items` in the rail. | Final view matches final click (`work-items`); no stale `bugs` rows bleed in (react-query keys carry `tslug`, so each table has its own cache entry — no collision). |
| **Boundary** | (a) A project with ONLY `work-items` (no extra table) — open it the old way. (b) A table whose slug is `board` or `work-items` (collision with route literals). | (a) `/work-items` route still renders identically — the shim path is unbroken. (b) A user table slugged `board` would collide with `/t/:tslug/board`'s sibling — note in Task 5: TanStack resolves `/t/board` to the grid route and `/t/board/board` to the kanban route, so a table literally named `board` still works; document the precedence. The server already allows such a slug. |
| **Mid-flow failure** | While viewing `/t/bugs`, the `bugs` table is deleted (via API/another tab). | Next refetch 404s; surfaces via `formatApiError` as an error panel, no white-screen crash. (SSE may invalidate; acceptable to require a manual refresh for v1 — record as deferral.) |

### Flow 2 — Open a non-default table's KANBAN board and persist board state to the RIGHT table

| Edge class | Case | Expected |
|---|---|---|
| **Happy path** | Click a kanban view under `bugs` in the rail → `/t/bugs/board`. | Board renders `bugs`' columns (bugs' statuses) + bugs' cards. |
| **Empty / zero state** | `bugs` has a kanban view but zero docs. | Empty board (columns from bugs' statuses, no cards), no crash. |
| **Denied actor** | Same as Flow 1 denied — server-enforced. | Error panel via `formatApiError`. |
| **Wrong-order / re-entry** | Deep-link `/t/bugs/board` directly. | Renders bugs' board, no rail state needed. |
| **Concurrent / double** | Drag a card to reorder on `/t/bugs/board`, then immediately switch to `/work-items` board. | The `board_position` PATCH lands on the **bugs** document (verify via API: bugs doc's `board_position` changed, NO work-items doc changed). **This is the invariant-16 Tier-A assertion.** |
| **Boundary** | Change group-by/sort on the `bugs` DEFAULT (unpinned) board, reload. | The group-by/sort persisted to **bugs'** active view (not work-items'). Verify via API the bugs view row changed. (Invariant 16: persist whenever `activeView` resolves, to the right entity.) |
| **Mid-flow failure** | Drag fails (server rejects the PATCH). | Optimistic move rolls back; toast via `formatApiError`; no divergence between UI and bugs' persisted order. |

### Flow 3 — Default `work-items` table is unaffected (back-compat)

| Edge class | Case | Expected |
|---|---|---|
| **Happy path** | Click `work-items` in the rail / open a project (`onProjectClick`). | Lands on `/work-items`, renders exactly as before this feature. |
| **Empty / zero state** | A fresh project's empty work-items table. | Unchanged empty state. |
| **Denied actor** | Excluded — unchanged from current behavior; server auth identical, not a new surface. | n/a |
| **Wrong-order / re-entry** | Existing `/work-items` deep-links + bookmarks. | Still resolve (route kept). |
| **Concurrent / double** | Excluded — same cache behavior as today for the single default table. | n/a |
| **Boundary** | `work-items` reached via BOTH `/work-items` AND `/t/work-items`. | Both render identically (`useCurrentTslug()` resolves both to `work-items`). |
| **Mid-flow failure** | Excluded — no new failure mode introduced on the default path. | n/a |

---

## Tasks

> Tier legend: **A** = behavioral RED→GREEN unit test required (logic that, if wrong, shows/writes data against the wrong table). **B** = no bespoke unit test; verify via full suite + seam reach (glue/routing/presentational), record `no unit test: Tier B, <reason>`.

---

### ── REVIEW CLUSTER 1: API data layer becomes table-scoped (Tasks 1–3) ──

*This cluster is the highest-risk: it re-scopes the data hooks every view reads/writes through. A mistake here shows or persists the wrong table's data. All Tier A.*

### Task 1: `documents.ts` — thread `tslug` through hooks + keys + invalidation

**Files:**
- Modify: `apps/web/src/lib/api/documents.ts`
- Test: `apps/web/src/lib/api/documents.test.tsx`

- [ ] **Step 1: Write the failing test** — assert the key carries `tslug` and the URL hits the `t/:tslug` path.

```tsx
// documents.test.tsx (add)
import { documentsKeys } from './documents.ts';

it('documentsKeys.list namespaces by tslug so two tables do not share a cache entry', () => {
  const a = documentsKeys.list('w', 'p', 'work-items', { type: 'work_item' });
  const b = documentsKeys.list('w', 'p', 'bugs', { type: 'work_item' });
  expect(a).not.toEqual(b);
  expect(a).toContain('work-items');
  expect(b).toContain('bugs');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && npx vitest run src/lib/api/documents.test.tsx`
Expected: FAIL — `documentsKeys.list` currently takes 3 args; calling with `tslug` either type-errors or the key lacks the slug.

- [ ] **Step 3: Implement** — add `tslug` to the key factory + hooks + align invalidation.

```ts
export const documentsKeys = {
  all: ['documents'] as const,
  list: (wslug: string, pslug: string, tslug: string, params: DocumentListParams = {}) =>
    [...documentsKeys.all, wslug, pslug, tslug, 'list', params] as const,
  detail: (wslug: string, pslug: string, slug: string) =>
    [...documentsKeys.all, wslug, pslug, 'detail', slug] as const,
};

export function useDocuments(
  wslug: string, pslug: string, tslug: string,
  params: DocumentListParams = {},
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: documentsKeys.list(wslug, pslug, tslug, params),
    queryFn: () =>
      client.get<DocumentListPage>(`/api/v1/w/${wslug}/p/${pslug}/t/${tslug}/documents${toSearch(params)}`),
    staleTime: 30_000,
    enabled: !!wslug && !!pslug && !!tslug && (options.enabled ?? true),
  });
}

export function useCreateDocument(wslug: string, pslug: string, tslug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { type: DocumentType; title: string; body?: string; frontmatter?: Record<string, unknown>; parentId?: string | null }) =>
      client.post<Document>(`/api/v1/w/${wslug}/p/${pslug}/t/${tslug}/documents`, vars),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: [...documentsKeys.all, wslug, pslug, tslug, 'list'] }),
  });
}
// useUpdateDocument: same — add tslug param, hit /t/${tslug}/documents/${slug},
// and align its invalidation prefix to [...documentsKeys.all, wslug, pslug, tslug, 'list'].
```

- [ ] **Step 4: Run to verify it passes** — `cd apps/web && npx vitest run src/lib/api/documents.test.tsx` → PASS. Then full suite `cd apps/web && npx vitest run`.
- [ ] **Step 5: Commit** — `git add apps/web/src/lib/api/documents.* && git commit -m "phase-N: table-scope documents hooks + keys"`

**Tier A** — the key/URL determines which table's docs are read and which is invalidated; wrong = a `bugs` view shows `work-items` rows or a create never refetches. RED-first proven on the key non-collision. **Unit test:** key namespaces by tslug; URL carries `t/${tslug}`. **Deferral line:** `Risk this test does NOT cover: the live invalidation seam (SSE create→refetch on the right table) — deferred to integration gate (Cluster-1 seam test, Task 3) + /shakeout Flow 1 concurrent edge.`

### Task 2: `statuses.ts` + `views.ts` — thread `tslug` through hooks + keys

**Files:**
- Modify: `apps/web/src/lib/api/statuses.ts`, `apps/web/src/lib/api/views.ts`
- Test: `apps/web/src/lib/api/views.test.tsx`, add a `statuses` key test (new or in an existing api test file)

- [ ] **Step 1: Write the failing test**

```tsx
import { statusesKeys } from './statuses.ts';
import { viewsKeys } from './views.ts';

it('statusesKeys + viewsKeys namespace by tslug', () => {
  expect(statusesKeys.list('w', 'p', 'work-items')).not.toEqual(statusesKeys.list('w', 'p', 'bugs'));
  expect(viewsKeys.list('w', 'p', 'work-items')).not.toEqual(viewsKeys.list('w', 'p', 'bugs'));
});
```

- [ ] **Step 2: Run to verify it fails** — `cd apps/web && npx vitest run src/lib/api/views.test.tsx` → FAIL (factories take only `wslug,pslug`).
- [ ] **Step 3: Implement** — add `tslug` to both key factories and every hook, hitting `/t/${tslug}/statuses` and `/t/${tslug}/views`.

```ts
// statuses.ts
export const statusesKeys = { list: (w: string, p: string, t: string) => ['statuses', w, p, t] as const };
export function useStatuses(wslug: string, pslug: string, tslug: string) {
  return useQuery({
    queryKey: statusesKeys.list(wslug, pslug, tslug),
    queryFn: () => client.get<Status[]>(`/api/v1/w/${wslug}/p/${pslug}/t/${tslug}/statuses`),
    staleTime: 5 * 60_000,
    enabled: !!wslug && !!pslug && !!tslug,
  });
}
// views.ts: viewsKeys.list(w,p,t) = ['views', w, p, t];
// useViews / useCreateView / useUpdateView / useDeleteView each take tslug,
// hit /t/${tslug}/views[/${id}], and invalidate viewsKeys.list(w,p,tslug).
```

- [ ] **Step 4: Run to verify it passes** — file test then full `cd apps/web && npx vitest run`.
- [ ] **Step 5: Commit** — `git commit -m "phase-N: table-scope statuses + views hooks"`

**Tier A** — same surface-correctness contract as Task 1. **Unit test:** both key factories namespace by tslug. **Deferral line:** `Risk this test does NOT cover: the un-mocked wire (does /t/bugs/views actually return bugs' views) — deferred to Task 3 seam test + /shakeout Flow 1.`

### Task 3: Wire the table-scoped hooks into `TableView` + `KanbanView` + `BoardControls` (the seam)

**Files:**
- Modify: `apps/web/src/components/table/table-view.tsx`, `apps/web/src/components/views/kanban-view.tsx`, `apps/web/src/components/kanban/board-controls.tsx`
- Test: `apps/web/src/components/table/table-view.test.tsx` (seam — render with `tslug="bugs"`, assert the bugs endpoints are hit)

- [ ] **Step 1: Write the failing seam test** — mount `<TableView tslug="bugs" …>` with the HTTP client un-mocked at the boundary (MSW or the project's existing request-capture); assert a request to `/t/bugs/documents` and `/t/bugs/statuses` fires (NOT `/p/<p>/documents`). Add ≥1 negative case: render with `tslug="work-items"` and assert it does NOT request `/t/bugs/...`.
- [ ] **Step 2: Run to verify it fails** — `cd apps/web && npx vitest run src/components/table/table-view.test.tsx` → FAIL (current component hits the project-scoped path).
- [ ] **Step 3: Implement** — in each component, pass the existing `tslug` prop into the now-tslug-aware hooks:

```tsx
// table-view.tsx (and parallel edits in kanban-view.tsx)
const { data: page, isLoading, error } = useDocuments(wslug, pslug, tslug, listParams);
const { data: statuses } = useStatuses(wslug, pslug, tslug);
const { data: viewsData } = useViews(wslug, pslug, tslug);
const update = useUpdateDocument(wslug, pslug, tslug, listParams);
const create = useCreateDocument(wslug, pslug, tslug);
const updateView = useUpdateView(wslug, pslug, tslug);
// relation-resolver useDocuments calls (relPages/relItems) also take tslug.
// onCreate keeps type:'work_item' — the table is scoped by the URL, not by type.

// board-controls.tsx
const { data: viewsData } = useViews(wslug, pslug, tslug);
const updateView = useUpdateView(wslug, pslug, tslug);
```

- [ ] **Step 4: Run to verify it passes** — seam test green; then `cd apps/web && npx vitest run` full suite (existing TableView/KanbanView tests must still pass — they render `tslug="work-items"`).
- [ ] **Step 5: Commit** — `git commit -m "phase-N: wire table-scoped hooks into views (invariant 16)"`

**Tier A** — this is the WIRING task AND the invariant-16 board-persistence seam (KanbanView `onDragEnd` + BoardControls now write to the active table's docs/view). Seam obligation: ≥1 un-mocked-boundary assertion (`/t/bugs/documents` fires) + ≥1 negative (`tslug="work-items"` does NOT hit bugs). **Unit test:** seam test above. **Deferral line:** `Risk this test does NOT cover: drag-reorder persists to the bugs document (not work-items) live — deferred to /shakeout Flow 2 concurrent/boundary edges (invariant-16 Tier-A browser assertion).`

**── REVIEW GATE (Cluster 1) ──** STOP. Reviewer holds Tasks 1–3 only: the data layer is now table-scoped end to end and the board persists to the right entity. Verify keys carry tslug, invalidation prefixes match read keys, and the seam test crosses the un-mocked wire. Integration gate: render `<TableView tslug="bugs">` against a fixture with a bugs-only status and confirm bugs rows + bugs status render (not work-items).

---

### ── REVIEW CLUSTER 2: Routes + default-table convergence (Tasks 4–6) ──

### Task 4: `default-table.ts` — the web convergence point

**Files:**
- Create: `apps/web/src/lib/default-table.ts`
- Test: `apps/web/src/lib/default-table.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { DEFAULT_TABLE_SLUG } from './default-table.ts';
it('DEFAULT_TABLE_SLUG matches the server seed slug', () => {
  expect(DEFAULT_TABLE_SLUG).toBe('work-items');
});
```

- [ ] **Step 2: Run to verify it fails** — module does not exist → FAIL.
- [ ] **Step 3: Implement**

```ts
// apps/web/src/lib/default-table.ts
import { useParams } from '@tanstack/react-router';

/** Web twin of the server's seed-project-defaults.ts DEFAULT_TABLE_SLUG. */
export const DEFAULT_TABLE_SLUG = 'work-items';

/** The single resolver for "which table am I on". Reads the route's :tslug
 *  param when present (the /t/:tslug routes), else the default. */
export function useCurrentTslug(): string {
  const params = useParams({ strict: false }) as { tslug?: string };
  return params.tslug ?? DEFAULT_TABLE_SLUG;
}
```

- [ ] **Step 4: Run to verify it passes** — `cd apps/web && npx vitest run src/lib/default-table.test.tsx`.
- [ ] **Step 5: Commit** — `git commit -m "phase-N: add web DEFAULT_TABLE_SLUG + useCurrentTslug (convergence point)"`

**Tier A** — `DEFAULT_TABLE_SLUG` is the load-bearing constant the back-compat routes + every `useFields` fix resolve to; a drift from the server's `'work-items'` silently routes the default table to a non-existent slug. The constant-match test is a real cross-binary contract (it would go RED if either side's slug changed). **Unit test:** constant equals `'work-items'`. (`useCurrentTslug` itself is Tier B glue — verified via the route tests in Task 5.) **Deferral line:** `Risk this test does NOT cover: useCurrentTslug reading the real route param — deferred to Task 5 route render tests.`

### Task 5: Create `/t/:tslug` + `/t/:tslug/board` routes

**Files:**
- Create: `apps/web/src/routes/w.$wslug.p.$pslug.t.$tslug.tsx`
- Create: `apps/web/src/routes/w.$wslug.p.$pslug.t.$tslug.board.tsx`
- Test: route render test (e.g. `apps/web/src/routes/t-tslug.test.tsx`)

- [ ] **Step 1: Write the failing test** — render the `/t/$tslug` route with `tslug="bugs"` in a test router; assert `<TableView>` receives `tslug="bugs"` (e.g. it requests `/t/bugs/documents`). RED because the route file does not exist yet.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — mirror `work-items.tsx`'s `validateSearch` exactly (copy the full `search` zod schema — do NOT reference it, repeat it):

```tsx
// w.$wslug.p.$pslug.t.$tslug.tsx
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { TableView } from '../components/table/table-view.tsx';

const stringOrArray = z.union([z.string(), z.array(z.string())]).optional();
const search = z.object({
  doc: z.string().optional(),
  view: z.string().min(1).optional(),
  status: stringOrArray,
  priority: z.string().optional(),
  labels: stringOrArray,
  assignee: z.string().optional(),
  updated_since: z.string().optional(),
  sort: z.string().min(1).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});

export const Route = createFileRoute('/w/$wslug/p/$pslug/t/$tslug')({
  validateSearch: search,
  component: TableRoute,
});

function TableRoute() {
  const { wslug, pslug, tslug } = Route.useParams();
  return <TableView wslug={wslug} pslug={pslug} tslug={tslug} />;
}
```

```tsx
// w.$wslug.p.$pslug.t.$tslug.board.tsx
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { KanbanView } from '../components/views/kanban-view.tsx';

export const Route = createFileRoute('/w/$wslug/p/$pslug/t/$tslug/board')({
  validateSearch: z.object({ doc: z.string().optional(), view: z.string().min(1).optional() }),
  component: BoardRoute,
});

function BoardRoute() {
  const { wslug, pslug, tslug } = Route.useParams();
  return <KanbanView wslug={wslug} pslug={pslug} tslug={tslug} />;
}
```

- [ ] **Step 3b: Regenerate the route tree** — `cd apps/web && npx vitest run` (or the project's `routeTree.gen.ts` generator if one runs in dev); confirm the new routes appear. NOTE the `/t/board` vs `/t/:tslug/board` precedence (Flow 1 boundary edge): TanStack treats `t/$tslug` and `t/$tslug/board` as distinct — a table slugged `board` resolves `/t/board` (grid) and `/t/board/board` (its kanban). Document this in a code comment.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `git commit -m "phase-N: add /t/:tslug + /t/:tslug/board routes"`

**Tier B** — file-route registration is glue over TanStack + a prop pass-through; the `validateSearch` schema is copied verbatim from the tested `work-items.tsx`. No bespoke logic of its own. Record `no unit test: Tier B, route registration + prop pass-through; behavior covered by the render-seam test (param→TableView) and /shakeout Flow 1 deep-link edge`. **Seam:** the render test asserting `tslug` reaches `TableView` IS the wire proof (route param → component). **Deferral line:** `Risk this test does NOT cover: live TanStack route-tree resolution + the /t/board slug-collision precedence — deferred to /shakeout Flow 1 boundary edge.`

### Task 6: Convert `work-items.tsx` + `board.tsx` to shims using the constant

**Files:**
- Modify: `apps/web/src/routes/w.$wslug.p.$pslug.work-items.tsx`, `apps/web/src/routes/w.$wslug.p.$pslug.board.tsx`

- [ ] **Step 1** — (Tier B, no new test) change the hardcoded `tslug="work-items"` to `tslug={DEFAULT_TABLE_SLUG}` (import from `../lib/default-table.ts`). Behavior identical; the constant removes the literal.
- [ ] **Step 2: Run the full suite** — `cd apps/web && npx vitest run`. Existing work-items/board route tests must still pass unchanged (proof of back-compat).
- [ ] **Step 3: Commit** — `git commit -m "phase-N: default-table routes use DEFAULT_TABLE_SLUG constant"`

**Tier B** — literal→constant swap, no behavior change. `no unit test: Tier B, constant swap; existing route tests are the regression guard`. **Deferral line:** `Risk this test does NOT cover: none new — back-compat asserted by the unchanged existing route tests staying green + /shakeout Flow 3.`

**── REVIEW GATE (Cluster 2) ──** STOP. Reviewer holds Tasks 4–6: routes + convergence point. Verify the new routes exist in the route tree, the shims resolve to `DEFAULT_TABLE_SLUG`, and `useCurrentTslug` reads the param. Integration gate: deep-link `/t/bugs` renders bugs (Flow 1 re-entry edge), `/work-items` still renders work-items (Flow 3).

---

### ── REVIEW CLUSTER 3: Rail navigation + sibling-site sweep (Tasks 7–10) ──

### Task 7: `w.$wslug.tsx` — stop discarding `_tslug` in the rail handlers

**Files:**
- Modify: `apps/web/src/routes/w.$wslug.tsx` (`onTableClick` ~206, `onViewClick` ~212, `onNewView` ~231, `currentRoute.tslug` ~298)
- Test: `apps/web/src/routes/w.$wslug.test.tsx`

- [ ] **Step 1: Write the failing test** — invoke the handlers (or the built rail tree) with `tslug="bugs"`; assert `navigate` is called with `to: '/w/$wslug/p/$pslug/t/$tslug'` and `params` containing `tslug: 'bugs'`; AND with `tslug="work-items"`, assert it routes to `/work-items` (back-compat). RED because today both route to `/work-items` discarding the slug.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — route default vs non-default:

```tsx
import { DEFAULT_TABLE_SLUG } from '../lib/default-table.ts';

onTableClick: (pslug: string, tslug: string) => {
  if (tslug === DEFAULT_TABLE_SLUG) {
    void navigate({ to: '/w/$wslug/p/$pslug/work-items', params: { wslug, pslug } });
  } else {
    void navigate({ to: '/w/$wslug/p/$pslug/t/$tslug', params: { wslug, pslug, tslug } });
  }
},
onViewClick: (pslug, tslug, viewId, type) => {
  const prev = searchRef.current;
  const next: Record<string, unknown> = { view: viewId };
  if (typeof prev.doc === 'string') next.doc = prev.doc;
  const isDefault = tslug === DEFAULT_TABLE_SLUG;
  const to = isDefault
    ? (type === 'kanban' ? '/w/$wslug/p/$pslug/board' : '/w/$wslug/p/$pslug/work-items')
    : (type === 'kanban' ? '/w/$wslug/p/$pslug/t/$tslug/board' : '/w/$wslug/p/$pslug/t/$tslug');
  const params = isDefault ? { wslug, pslug } : { wslug, pslug, tslug };
  void navigate({ to, params, search: next });
},
// onNewView: thread tslug to setNewViewSheet so the sheet creates the view on the right table (see Task 9).
```

Also populate `currentRoute.tslug` from the path so the rail highlights the active table:

```tsx
const activeTslug = currentPath.match(/\/t\/([^/]+)/)?.[1];
// in buildRailTree currentRoute: { ..., tslug: activeTslug }
```

- [ ] **Step 4: Run to verify it passes** — file test then `cd apps/web && npx vitest run`.
- [ ] **Step 5: Commit** — `git commit -m "phase-N: rail routes by real tslug (default→/work-items, else /t/:tslug)"`

**Tier A** — this is the NAVIGATION-RESOLVES-THE-RIGHT-TABLE logic the brief flagged Tier A: a wrong branch sends a `bugs` click to `work-items`. RED-first on both branches (default→/work-items, non-default→/t/:tslug, both with correct params). **Unit test:** handler routes default vs non-default to the right `to`+`params`. **Deferral line:** `Risk this test does NOT cover: the live rail-click→render in the browser — deferred to /shakeout Flow 1 happy path.`

### Task 8: Sibling-site sweep — `useFields('work-items')` literals

**Files:**
- Modify: `apps/web/src/components/views/list-view.tsx:51`, `apps/web/src/components/slideover/document-slideover.tsx:572`, `apps/web/src/components/views/new-view-sheet.tsx:42`

- [ ] **Step 1** — (each is Tier B) replace `useFields(wslug, pslug, 'work-items')` with `useFields(wslug, pslug, useCurrentTslug())` so these surfaces follow the active table. Verify each component is rendered within a `/t/:tslug` or default route (so `useCurrentTslug` resolves correctly).
- [ ] **Step 2: Run the full suite** — `cd apps/web && npx vitest run`.
- [ ] **Step 3: Commit** — `git commit -m "phase-N: sibling-site sweep — fields follow current table"`

**Tier B** — literal→hook swap, no branching logic. `no unit test: Tier B, hardcoded-slug→useCurrentTslug swap; behavior covered by /shakeout (a bugs doc's slideover shows bugs' fields)`. **Sibling-site audit:** this task IS the sweep for the `'work-items'` TS-literal cross-cutting concern — grep `rg "'work-items'" apps/web/src --type ts` after, confirm only the constant definition + intentional default-route shims remain. **Deferral line:** `Risk this test does NOT cover: the slideover/new-view-sheet rendering the WRONG table's fields when opened from /t/bugs — deferred to /shakeout (add a Flow-1 sub-check: open a bugs doc, confirm bugs' fields).`

### Task 9: `new-view-sheet.tsx` — create the view on the active table + route there

**Files:**
- Modify: `apps/web/src/components/views/new-view-sheet.tsx:100-105`, and `w.$wslug.tsx`'s `onNewView`/`setNewViewSheet` to carry `tslug`
- Test: `apps/web/src/components/views/new-view-sheet` test if one exists, else cover via the create-view hook test

- [ ] **Step 1: Write the failing test** — creating a view from the sheet while `tslug="bugs"` calls `useCreateView(wslug, pslug, 'bugs')` (hits `/t/bugs/views`), and on success navigates to `/t/bugs` or `/t/bugs/board` (not `/work-items`). RED because the sheet hardcodes `work-items`.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** — thread the sheet's `tslug` (from `setNewViewSheet({ pslug, tslug })`) into `useCreateView`/`useFields` and the post-create `to`. Default table → `/work-items`|`/board`; non-default → `/t/:tslug`|`/t/:tslug/board`.
- [ ] **Step 4: Run to verify it passes** — file test then full suite.
- [ ] **Step 5: Commit** — `git commit -m "phase-N: new-view-sheet creates + routes on the active table"`

**Tier A** — the view is CREATED on a table; wrong tslug creates a `work-items` view from the `bugs` rail (data written to the wrong surface). RED-first on the create-target table. **Unit test:** create-from-sheet targets the active table + routes there. **Deferral line:** `Risk this test does NOT cover: the live create→rail-appears-under-bugs flow — deferred to /shakeout (Flow 2 setup creates a bugs kanban view).`

### Task 10: Mid-flow-failure + denied-actor render check (error envelope)

**Files:**
- Test only: extend `apps/web/src/components/table/table-view.test.tsx` (or a route test)

- [ ] **Step 1: Write the test** — when `useDocuments` for `/t/bugs` rejects with the `{ error: { code, message } }` envelope (deleted table → 404, or denied → 403), `TableView` renders the error panel via `formatApiError` (the existing `error ? <div className="…text-danger">` branch), NOT a blank grid or a crash.
- [ ] **Step 2: Run to verify it passes** — the existing error branch should already handle this; this test PINS the contract for the new table-scoped path (invariant 9). If it fails, fix the error branch.
- [ ] **Step 3: Commit** — `git commit -m "phase-N: pin error-envelope render for table-scoped fetch failures"`

**Tier A** — error-path contract on the new data surface (untrusted outcome: a 404/403 must surface, not crash). RED-first if the error branch doesn't catch the table-scoped failure. **Unit test:** above. **Deferral line:** `Risk this test does NOT cover: the LIVE table-deleted-mid-view transition (SSE/refetch timing) — deferred to /shakeout Flow 1 + Flow 2 mid-flow-failure edges.`

**── REVIEW GATE (Cluster 3) ──** STOP. Reviewer holds Tasks 7–10: navigation + sibling sweep + error path. Verify the rail routes by real tslug (both branches), no `'work-items'` literal survives outside the constant + default-route shims, and the error envelope renders. Integration gate: in the dev server, click `bugs` in the rail → URL is `/t/bugs`, bugs data renders; create a view under bugs → it appears under bugs, not work-items.

---

### ── REVIEW CLUSTER 4: Invariant authoring + acceptance drive (Task 11) ──

### Task 11: Author invariant 18 + run the acceptance matrix

**Files:**
- Modify: `ARCHITECTURE-INVARIANTS.md`

- [ ] **Step 1** — Author invariant **18** (current-table resolution + `DEFAULT_TABLE_SLUG` convergence) into `ARCHITECTURE-INVARIANTS.md`, using the text drafted in this plan's `## Architecture invariants touched` → "NEW convergence point proposed" block. Point it at `apps/web/src/lib/default-table.ts`.
- [ ] **Step 2** — Run the full regression: `cd apps/web && npx vitest run` (green) + `bun x tsc --noEmit` in `apps/web` (clean).
- [ ] **Step 3** — Run `/shakeout`, which drives `feature-acceptance` against the `## Acceptance flows` matrix above through the real browser (Playwright/`use_browser`) + the un-mocked wire for the API edges (the invariant-16 "board_position lands on the bugs doc" assertion is API-verified). Emit the pass/fail/not-reachable manifest.
- [ ] **Step 4: Commit** — `git commit -m "phase-N: author invariant 18 (web current-table convergence)"`

**Tier B** — doc authoring + gate invocation, no code logic. `no unit test: Tier B, doc + acceptance-drive`. **Deferral line:** `Risk this test does NOT cover: nothing further — this task IS the acceptance drive that exercises every deferred risk above.`

**── REVIEW GATE (Cluster 4) ──** STOP. Final holistic review of the whole branch diff before merge: confirm the acceptance manifest is all-pass (especially Flow 2's invariant-16 board-persistence edge), tsc clean across `apps/web`, and the invariant doc names the new convergence point.

---

## Per-phase Integration gates (summary)

- **After Cluster 1:** `<TableView tslug="bugs">` renders bugs' rows + bugs' statuses against a two-table fixture (not work-items).
- **After Cluster 2:** deep-link `/t/bugs` renders bugs; `/work-items` unchanged (back-compat).
- **After Cluster 3:** rail click on `bugs` → `/t/bugs` + bugs data; new-view-under-bugs appears under bugs.
- **After Cluster 4:** full `feature-acceptance` manifest all-pass; invariant 18 authored.

## Self-review (planner, fresh-eyes pass)

- **Spec coverage:** route taking tslug (Task 5) ✓; rail stops discarding `_tslug` (Task 7) ✓; default-table routing decision (locked above + Tasks 6/7) ✓; breadcrumb/current-table context (`useCurrentTslug` Task 4 + `currentRoute.tslug` Task 7) ✓; data-fetch by slug (Tasks 1–3 — the real gap) ✓; sibling `'work-items'` triage (Task 8) ✓.
- **Type consistency:** `useDocuments`/`useStatuses`/`useViews`/`useUpdateView`/`useCreateDocument`/`useUpdateDocument`/`useCreateView`/`useDeleteView` all gain `tslug` as the 3rd positional arg (after `wslug, pslug`), consistent across every call site and matching the existing `useFields(wslug,pslug,tslug)` shape. `DEFAULT_TABLE_SLUG`/`useCurrentTslug` named identically everywhere.
- **Placeholder scan:** every code step shows real code; no TBD/"add error handling" placeholders.
- **Gap check:** the only server-side assumption (that `/t/:tslug/{documents,statuses,views}` exist) is ground-truthed against `app.ts:99-105` — no server change needed.
