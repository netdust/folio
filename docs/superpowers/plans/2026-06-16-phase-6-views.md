# Phase 6 — Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan is delivered on ONE branch `phase-6/views` across **6 review clusters** — STOP at each `── REVIEW GATE ──` for a review at that cluster's stated tier before continuing. Five clusters are STANDARD; ONE (cluster 2a, the group-summary endpoint) is **FULL** (a new parsing→SQL surface — see its gate).

**Goal:** Replace Folio's route-based Work-items/Board tabs with a NocoDB-style saved-view model: `view.type` becomes the source of truth, a `<ViewRouter>` switches renderer by type, and **four** new render modes — a NocoDB-style **grouped LIST** (grouped cards with per-group configurable aggregate summary headers), **calendar**, **timeline**, **gallery** — plus a new `image` field type are added. The existing spreadsheet **table** renderer (today's TableView) and **kanban** migrate onto the new architecture UNCHANGED.

> **Scope clarification (2026-06-16, Stefan):** the `list` view type is NOT the existing TableView re-skinned. It is a DISTINCT NEW render mode — a grouped list of composed rich-rows, grouped by a chosen field, with per-group **configurable aggregate** summary headers (count / %-matching / average / sum / a status-distribution bar). The existing spreadsheet UI keeps rendering as the **table** type. This adds a sixth view type and a new server contract (a group-summary endpoint); the rest of the plan is unchanged in shape.

**Architecture:** A *view* is a saved, named, typed, configured lens on a table. Creating a view picks its type; switching views selects a saved view (which carries its own type + filter/group/sort/settings). The unified route `/w/$wslug/p/$pslug/t/$tslug?view=<id>` (plus the default-table legacy path) renders a `<ViewRouter>` that switches on the resolved view's `type`. Old `/work-items` and `/board` URLs back-compat-redirect so nothing 404s. The new view types are additive renderers; the per-view config (which date field drives a calendar, which image field is a gallery cover, the grouped-list's group-by + aggregate specs + row layout) rides a new `views.settings` JSON column.

**`table` vs `list` (the renamed spreadsheet — RESOLVED, see "Decision: table-vs-list" below):** today the seeded default view is `type:'list'` and renders the spreadsheet TableView. Under the new model the spreadsheet becomes a NEW `table` type, and `list` is REPURPOSED to mean the grouped-list renderer. Because every existing `list` row today IS a spreadsheet, a **data migration backfills all existing `views.type='list'` → `'table'`** (Cluster 1, Task 1.0b) and the seed creates a `table` default — so no existing project's default view silently flips to a grouped list. This was attacked under `doubting-decisions` (the confirmation-bias trap would be reusing `list` for the spreadsheet to dodge a migration — it contradicts Stefan's explicit "list+kanban+table all migrate" note and would silently re-render every project). The backfill makes cluster 1 a **data-layer** cluster → promoted to FULL tier (see cluster sizing).

**The grouped-list view (Cluster 2a/2b):** the `list` renderer is a NocoDB-style grouped list — rows as composed rich-cards, grouped by a chosen field, with per-group **configurable aggregate** summary headers (count / %-rows-matching-a-value / average / sum / a status-distribution bar). The aggregates compute **server-side** over the FULL filtered set (not the loaded page) via a new `GET .../documents/group-summary` endpoint — the honest scalable fix that avoids the page-2-aggregate bug class M3 just closed. That endpoint is a new parsing→SQL surface and gets a threat model + reuses the M3 filter compiler + the M3 $contains whitelist/bound/cap hardening (see "## Threat model — group-summary endpoint" and Cluster 2a).

**Tech Stack:** React + Vite + TanStack Router, Tailwind + shadcn/ui, dnd-kit (drag-to-reschedule), Hono + Drizzle (SQLite), Zod at boundaries, Bun test (server/shared), Vitest (web), Playwright (e2e).

---

## Classification & gate decisions (Stage 1, harnessed-development)

**Class A** — new multi-task feature, multi-cluster delivery on a new branch. Brainstorm (Stage 0) is DONE (design locked with Stefan); this is Stage 1 only.

**Gates fired:**

- **1g feature-acceptance — FIRED.** Clusters 1 (view-switching UX), **2b (grouped-list)**, 3 (calendar), 4 (timeline), 5 (gallery) are user-facing. Each carries an `## Acceptance flows` matrix with the six edge classes. The grouped-list matrix (Cluster 2b) additionally drives the **aggregate-correctness-across-pages** case for real (247 rows paginated; group headers must show full-group totals, NOT page totals). *Trigger: a view, a flow, a CRUD-adjacent surface a user drives.*
- **1a threat-model — FIRES for Cluster 2a (group-summary endpoint).** The new `GET .../documents/group-summary` takes a client-supplied `groupBy` field key + an `aggregates[]` spec (each = field + aggregation op) + a `filter=` param, and compiles them into a `GROUP BY json_extract(...)` SQL query with `AVG`/`SUM`/`COUNT(CASE WHEN ...)` aggregations. This is the SAME parsing→SQL trust-boundary class as the M3 `$contains` filter surface. An embedded **`## Threat model — group-summary endpoint`** section (below) names the assets, the injection/DoS attacks, and the whitelist/bound/cap mitigations BEFORE the task breakdown. *Trigger run literally: untrusted parsing of a client spec into SQL + a server query whose cost the client controls (groupBy cardinality × aggregate count).* The image-field surface remains ASSESSED-NOT-FIRED (its own mini-assessment below is unchanged).
- **designing-apis — FIRES for Cluster 2a (new server contract).** `group-summary` is a NEW HTTP boundary (not an in-place extension of an existing route like the rest of the plan). The `designing-apis` craft shaped its contract-first: request shape (`groupBy`, `aggregates[]`, `filter`), response shape (per-group `{ value, count, aggregates: {…} }[] + ungrouped bucket`), the one structured error shape (`INVALID_GROUP_BY` / `INVALID_AGGREGATE` 422 via the existing serializer), boundary validation (a shared validator mirroring `filterCompile`), and its convergence points (scope via `pScope`/`canSeeProject` ceiling; errors via the shared serializer; validation at the edge). See "## Contract — group-summary endpoint" below. *Trigger: the plan designs a new API boundary.*
- **1b architecture-invariants — FIRED.** The renderAs refactor IS a change to **invariant 18** (web current-table/view-nav convergence point). The `## Architecture invariants touched` note below cites it and specifies how `<ViewRouter>` + the unified route keep the "which renderer for this view" decision converged. Also touches **invariant 16** (board persistence — verify per-view config writes stay table-scoped) and **invariant 10** (the new `views.settings` column + the `image` field type — confirmed config-of-existing-entity, not a new table). The new **group-summary read path (Cluster 2a)** is a new read endpoint → cite **invariant 4a** and its **batched-child-read corollary** (added 2026-06-16 by the M3 batched-views endpoint): group-summary mounts under `pScope` (`resolveProject` + `requireResource()`), so `canSeeProject` is its ceiling and every aggregate is scoped `eq(documents.projectId, p.id)` server-side — it can never out-scope its resolved parent. *Trigger: the plan touches a named convergence point.*
- **1a threat-model — ASSESSED, NOT FIRED (verdict below).** The new `image` field type is a stored display URL rendered client-side in an `<img>`. The server NEVER fetches it (confirmed: `validatePublicUrl` in `apps/server/src/lib/url-allow-list.ts` guards only the runner's outbound AI-provider/baseUrl fetches; the field-renderer's existing `url` type renders an `<a href>` with no server round-trip, and `image` mirrors that as `<img src>`). No SSRF surface on the server. The one residual — an `<img src>` to an internal/tracking URL causing a *browser-side* request — is a pre-existing property of the existing `url` type and of any markdown body image; it is out of scope and noted in the mini-assessment below rather than a full `## Threat model` section. *Trigger list run literally: no user-controlled URL the SERVER fetches, no auth/token/parsing/BYOK/tenancy surface touched.*

**Gates NOT fired (and why):**

- **designing-apis** — fires for Cluster 2a ONLY (the group-summary endpoint, see fired list above). For the rest of the plan it does NOT fire: the views + fields routes already exist and are extended in place (enum widen + one new JSON column), no new boundary shape.
- **doubting-decisions** — the architecture (Option B, renderAs-first) is already decided and pressure-tested with Stefan; not re-opened.

**Review-cluster sizing (1f) + provisional tier (1h):** **6 review clusters** across the new branch. Ordering (Stefan's choice): (1) renderAs foundation → (2a) group-summary endpoint+types → (2b) grouped-list renderer+config UI → (3) image field → (4) calendar → (5) timeline → (6) gallery+G3. The grouped-list work is **split into TWO review clusters** (2a / 2b) per the 1f ≤3–4-task rule AND the 1h mixed-tier rule: a FULL-tier server/SQL surface (2a) must not share a review hold with a STANDARD-tier renderer/UI surface (2b).

| Cluster | What it touches | Tier |
|---|---|---|
| **1 — renderAs foundation** | invariant 18 (UI routing) **+ a data migration** (backfill `list`→`table`, add `views.settings`) | **FULL** — touches the data layer / a migration backfill (1h FULL trigger). The migration is non-destructive but rewrites existing rows, and the schema change is the foundation every cluster builds on. |
| **2a — group-summary endpoint + shared types** | a NEW parsing→SQL endpoint (client `groupBy`+`aggregates[]`→`GROUP BY json_extract` SQL); reuses the M3 filter compiler | **FULL** — a 1a surface (untrusted-parse→SQL, like `$contains`); security-sentinel reviews this cluster + the named threat-model mitigations. |
| **2b — grouped-list renderer + config UI** | a new client renderer + the new-view/edit config UI for group-by/aggregates/row-layout | **STANDARD** — multi-file UI feature; reads the 2a endpoint (already hardened); no 1a surface of its own. |
| **3 — image field** | new field type, client-rendered, server never fetches | **STANDARD** (image mini-assessment ruled no server SSRF). |
| **4 — calendar** | additive renderer; writes via tested document PATCH | **STANDARD**. |
| **5 — timeline** | additive renderer; writes via tested PATCH + tested useUpdateView | **STANDARD**. |
| **6 — gallery + G3** | additive renderer reusing the tested safe-URL guard; G3 CSS | **STANDARD**. |

**One-way escalation:** any 1a finding during a STANDARD cluster review promotes THAT cluster to FULL. (Cluster 1's promotion to FULL is the data-migration trigger, applied proactively.)

---

## Architecture invariants touched

Per `ARCHITECTURE-INVARIANTS.md`:

- **Invariant 18 (web current-table/view resolution) — DIRECTLY CHANGED.** Today the convergence point is `DEFAULT_TABLE_SLUG`/`useCurrentTslug` (`apps/web/src/lib/default-table.ts`) + `resolveTableNav`/`resolveViewNav`/`activeTableFromPath`/`activeTabFromPath` (`apps/web/src/lib/rail-nav.ts`). The renderAs refactor ADDS a new decision — *"which renderer renders this view?"* — which MUST also converge in ONE place: the new `viewRendererFor(type)` map consumed only by `<ViewRouter>` (`apps/web/src/components/views/view-router.tsx`). The plan **updates invariant 18** (Task 1.7) to name `<ViewRouter>` + `viewRendererFor` as the renderer-resolution convergence point, and to record that `resolveViewNav` now routes ALL view clicks to the unified `/t/$tslug?view=<id>` route (the per-type `?: '/board'` branch is retired; legacy `/work-items`+`/board` become redirect-only). A second inline `switch (view.type)` that picks a renderer anywhere else is a bug.
- **Invariant 16 (board-view persistence) — VERIFY, not changed.** The new per-view config (calendar date field, gallery cover field, timeline range) persists to the ACTIVE view's `views.settings` via `useUpdateView` — the same entity/trigger rule as group-by/sort. The plan must NOT route a `documents.board_position` write through `useUpdateView`, and a calendar drag-to-reschedule writes the DATE FIELD to the **document** (via the document PATCH), NOT to the view. Cluster 3 Task notes call this out.
- **Invariant 10 (entity modeling — DATA before tables) — CONFIRMED COMPLIANT.** The new `image` field type is a `fields.type` value (data), not a table. The new per-view config is a `views.settings` JSON column (config of the existing `views` entity), not a new table. Both are within the convergence point. The one migration (Task 2.0 / 1.5) adds a nullable JSON column; re-confirm before writing the `.sql` that it is an attribute of an existing entity (it is).

---

## Image-field threat mini-assessment (1a — assessed, full section NOT required)

**What changes:** a new `image` field type. A user stores a URL string in `documents.frontmatter[<key>]`; the gallery cover and the field-renderer render it as `<img src={url}>` client-side.

**Server surface:** NONE. The server stores the string verbatim in the `frontmatter` JSON blob (same path as today's `url`/`string` fields — no new parsing, no new outbound fetch). `validatePublicUrl` (the SSRF guard for AI-provider baseUrls) does NOT and should NOT apply — the server never dereferences the URL.

**Client surface (residual, OUT of scope):** an `<img src="http://169.254.169.254/...">` or `<img src="http://tracker/pixel">` causes the *viewer's browser* to issue a GET. This is (a) a pre-existing property of the existing `url` field type's `<a href>` and of any `![](url)` in a markdown body, (b) only reachable by a user who already has write access to the team's frontmatter (one team, one instance — no tenancy boundary to cross, per CLAUDE.md), and (c) not a server-side SSRF. **Mitigation in scope:** the `image` field's URL input validates scheme is `http(s):` client-side (reject `javascript:`/`data:` to avoid an `<img>`-onerror or stored-XSS-via-attribute foothold) and the `<img>` carries `referrerPolicy="no-referrer"` + `loading="lazy"`. That single client-side validation (Task 2.3, Tier A) is the whole security ask. **Verdict: no `## Threat model` section — the surface is one client-side scheme check on a single-team, server-never-fetches field.**

---

## Threat model — group-summary endpoint (1a — FIRES for Cluster 2a)

> For the new `GET /api/v1/w/:wslug/p/:pslug/documents/group-summary` (written 2026-06-16, Phase 6). It exists because this endpoint compiles a CLIENT-SUPPLIED spec (groupBy field + aggregate ops + filter) into a `GROUP BY json_extract(...)` SQL query — the SAME untrusted-parse→SQL trust-boundary class as the M3 `$contains` filter surface (which shipped a CRITICAL SQL/DoS finding before its whitelist/bound/cap landed). This section is the convergence target so `/code-review` + `security-sentinel` verify against named mitigations instead of re-discovering the surface.

### What we're defending
- **The SQLite query plan / server CPU+memory** — an unbounded `GROUP BY` over a huge-cardinality json_extract expression, or many aggregates × many groups, is a CPU/DoS amplifier on the single-binary server.
- **Query integrity** — the `groupBy` field key and aggregate field keys are interpolated into a `$.<key>` json path (the existing `fieldSortExpr` pattern); an unvalidated key is an injection foothold.
- **Project-scope integrity (invariant 4a)** — the aggregate MUST be computed only over documents in the resolved project; a missing `projectId` predicate leaks/aggregates cross-project rows.
- **Correctness as a contract (Hyrum's Law)** — callers will depend on "the header total is the FULL-group total." A page-scoped aggregate that looks right on page 1 is a silent correctness bug (the M3 page-2 class).

### Who we're defending against
- **Authenticated team members (single team, IN scope for DoS + correctness, OUT for tenancy):** one instance = one team (CLAUDE.md), so there is NO cross-tenant attacker — but a member (or a compromised agent token acting in-project) can still craft an expensive or malformed spec. The threat is resource-exhaustion + injection-via-spec, not cross-tenant read.
- **A compromised/steered agent token** with project write/read — same spec-crafting reach over MCP/HTTP. IN scope (bound the cost; whitelist the ops).
- **External unauthenticated attacker** — OUT of scope: the endpoint is behind `pScope` (`resolveProject` + `requireResource()`); no auth bypass is in this surface.

### Attacks to defend against
1. **Aggregation-op injection / unknown op → SQL error or arbitrary SQL fragment.** Client sends `aggregates:[{ field:'x', op:'sum); DROP…' }]` or an op the builder string-concatenates. If the op is not a closed whitelist mapped to fixed SQL fragments, it is an injection or a 500.
2. **groupBy / aggregate FIELD-key injection into the `$.<key>` json path.** A key like `due_date'); ...` or with path-traversal-ish characters interpolated into `json_extract(frontmatter, '$.<key>')` corrupts the query.
3. **DoS via aggregate count.** `aggregates:[…200 specs…]` → 200 aggregate expressions in one SELECT → CPU blowup (the `MAX_FILTER_CLAUSES` analogue).
4. **DoS via huge group cardinality.** `groupBy` on a high-cardinality free-text field → millions of groups materialized + returned. Must bound the returned group count (top-N) and/or the field domain.
5. **DoS via the `filter=` param** (inherited surface). The reused filter compiler already caps clauses + `$contains` fan-out — but the endpoint must enforce the SAME 8192-byte raw-filter cap BEFORE parse (mirroring `documents.ts`).
6. **Cross-project aggregation (invariant 4a).** A missing `eq(documents.projectId, p.id)` predicate aggregates rows outside the resolved project.
7. **Page-scoped aggregate masquerading as full-group (correctness/integrity).** Aggregating over a loaded page instead of the full filtered set → wrong headers (the M3 page-2 bug class).
8. **Distribution-bar cardinality blowup.** The status-distribution aggregate is a sub-GROUP BY on a second field; an unbounded distinct-value count per group is a second amplifier — bound the distinct buckets returned.

### Mitigations required (numbered to attacks; each code-checkable)
1. **Closed aggregation-op whitelist** in `apps/server/src/lib/group-summary.ts`, mirroring `filterCompile`'s `OPERATORS` set: `const AGGREGATIONS = new Set(['count','pct_matching','avg','sum','distribution'])`. Each op maps to a FIXED parametrized SQL fragment (`COUNT(*)`, `COUNT(CASE WHEN <fieldExpr> = ${value} THEN 1 END)*100.0/COUNT(*)`, `AVG(CAST(<fieldExpr> AS REAL))`, `SUM(CAST(<fieldExpr> AS REAL))`, a `GROUP BY g,v` sub-count). Unknown op → throw `GroupSummaryError` → 422 `INVALID_AGGREGATE`. NO op string ever reaches SQL un-mapped.
2. **Field-key validation reusing the existing pattern** (`apps/server/src/services/documents.ts` line ~98): every `groupBy` key + each aggregate `field` MUST match `/^[a-zA-Z0-9_]+$/` AND be a registered `fields` row for the project (or a built-in column: `status`/`title`/`type`). The `pct_matching` op's match-VALUE flows through Drizzle as a BOUND param (`${value}`), never interpolated. Reject non-conforming keys → 422 `INVALID_GROUP_BY`.
3. **`MAX_AGGREGATES = 10` cap** (the `MAX_FILTER_CLAUSES` analogue). >10 aggregate specs → 422.
4. **Top-N group cap (`MAX_GROUPS = 200`)** — `ORDER BY count DESC LIMIT 200` on the group dimension; the response flags `truncated:true` when there are more groups, so the UI shows "+N more" rather than materializing unbounded groups.
5. **8192-byte raw-`filter` cap BEFORE JSON.parse** (copy the `documents.ts` HIGH-2 guard verbatim) + reuse `filterCompile` (clause cap + `$contains` cap inherited) → `compileFilterToWhere` for the `WHERE`.
6. **`eq(documents.projectId, p.id)` is ALWAYS in the WHERE** — the service takes `projectId` as a required arg (mirroring `listDocuments`); the endpoint mounts under `pScope` so `getProject(c)` is the resolved, access-checked project (invariant 4a + the batched-child-read corollary — the parent's `canSeeProject` is the ceiling).
7. **Aggregate over the FULL filtered set, NEVER a page** — the group-summary query has NO `limit`/`cursor` on the document rows; it is a single `GROUP BY` over `WHERE projectId AND <filter>`. The paginated document LIST is a SEPARATE query (the renderer fetches both). A 247-rows-across-pages correctness test asserts the header totals equal the full-set totals, not the page-1 count.
8. **Distinct-bucket cap on the distribution aggregate (`MAX_DISTRIBUTION_BUCKETS = 50`)** — the sub-count returns at most 50 distinct values per group; the rest fold into an "other" bucket.

### Out of scope (explicit deferrals)
- **Per-member cross-tenant isolation** — N/A (one instance = one team; no tenancy boundary, per CLAUDE.md). The endpoint defends DoS + injection + project-scope, NOT tenant isolation.
- **Denial-of-wallet / rate limiting** of the endpoint beyond the cost caps — deferred to the global rate-limit layer (v1.1); the caps above bound a SINGLE query's cost.
- **Caching/memoizing group summaries** — deferred; each request recomputes. Acceptable at v1 scale.
- **Aggregating across projects** (a cross-project rollup) — explicitly NOT supported (invariant 4a); a future feature would need its own threat model.

### How to use this section
- Controller pre-flight: before dispatching Cluster 2a, verify the plan's L.1 task supplies the whitelist + the field-key validator + the caps (mitigations 1–8) as code, not prose.
- `/code-review` on Cluster 2a: "Verify against the group-summary threat model. Check each numbered mitigation (1–8) is in place; report in-place / missing / out-of-scope per the deferrals."
- `security-sentinel` reviews Cluster 2a (FULL tier) against this section + `references/security-checklist.md` (the SSRF/injection/untrusted-parse controls).
- `/evaluate` retro: any missing mitigation is a plan-correction defect. Downstream clusters cross-reference, don't re-litigate.

---

## Contract — group-summary endpoint (designing-apis, Cluster 2a)

> Contract-first (the consumer's view). The renderer (2b) only ever sees this shape; the service satisfies it.

**Request:** `GET /api/v1/w/:wslug/p/:pslug/documents/group-summary` (mounts under `pScope` → project access-checked).
Query params:
- `groupBy` (string, required) — a frontmatter field key or built-in column (`status`/`type`); validated per mitigation 2.
- `aggregates` (JSON string, optional) — `AggregateSpec[]`, each `{ field?: string; op: 'count'|'pct_matching'|'avg'|'sum'|'distribution'; value?: string }` (`value` required for `pct_matching`; `field` required for avg/sum/pct_matching/distribution; `count` needs neither). Max 10 (mitigation 3).
- `filter` (JSON string, optional) — same `FilterInput` shape as `GET /documents`; reused compiler; 8192-byte cap (mitigation 5).
- `type` (string, optional) — `work_item` (default) to scope to the active table like the list does.

**Response (200):** `{ data: { groups: GroupSummaryRow[]; ungrouped: GroupSummaryRow | null; truncated: boolean } }` where
`GroupSummaryRow = { value: string | null; count: number; aggregates: Record<string /*specKey*/, number | DistributionBucket[]> }` and
`DistributionBucket = { value: string; count: number }`. The `ungrouped` row buckets documents whose `groupBy` field is missing/empty (the "no group" bucket the UI renders at the bottom). `truncated:true` when group count hit `MAX_GROUPS` (mitigation 4).

**Errors (the ONE structured shape via the existing serializer):** `INVALID_GROUP_BY` (422, bad/unknown field key), `INVALID_AGGREGATE` (422, unknown op / too many / missing required field|value), `INVALID_FILTER` (422, reused from documents). Callers branch on `code`, never parse `message`.

**Convergence points named (for the 1b gate):** scope → `pScope` + `getProject(c)` (`canSeeProject` ceiling, invariant 4a); errors → the shared `registerErrorHandler` serializer; validation → a single `validateGroupSummaryRequest` at the boundary (mirrors `filterCompile`). Additive-only thereafter: new aggregation ops are added to the whitelist (a new optional capability), never removing or repurposing a response key.

---

## File structure (created / modified)

**Cluster 1 — renderAs foundation** (FULL — includes a data migration)
- Create: `apps/server/src/db/migrations/00NN_view_settings.sql` (+ `_journal.json`) — adds `views.settings` JSON column
- Create: `apps/server/src/db/migrations/00NN_backfill_list_to_table.sql` (+ `_journal.json`) — `UPDATE views SET type='table' WHERE type='list'` (Task 1.0b)
- Modify: `apps/server/src/lib/seed-project-defaults.ts` (seed default view `type:'list'` → `'table'`)
- Create: `apps/web/src/components/views/view-router.tsx` (the `<ViewRouter>` + `viewRendererFor` map — the renderer convergence point; `table`→TableView, `list`→grouped-list placeholder until 2b)
- Create: `apps/web/src/lib/api/use-active-view.ts` (resolve the active `View` from `?view=` + table's view list, with default fallback)
- Modify: `apps/web/src/routes/w.$wslug.p.$pslug.work-items.tsx` (→ redirect to unified route)
- Modify: `apps/web/src/routes/w.$wslug.p.$pslug.board.tsx` (→ redirect to unified route)
- Modify: `apps/web/src/routes/w.$wslug.p.$pslug.t.$tslug.tsx` (→ render `<ViewRouter>`)
- Modify: `apps/web/src/routes/w.$wslug.p.$pslug.t.$tslug.board.tsx` (→ redirect to unified route)
- Modify: `apps/web/src/lib/rail-nav.ts` (`resolveViewNav` → always unified route)
- Modify: `apps/web/src/components/views/new-view-sheet.tsx` (type picker offers all 5; route to unified)
- Modify: `apps/web/src/routes/w.$wslug.p.$pslug.tsx` (tabs → saved-view switcher; G4 panel toggle in toolbar)
- Modify: `apps/web/src/components/shell/main-frame.tsx` (G4: a visible operator-panel toggle in the frame toolbar)
- Modify: `ARCHITECTURE-INVARIANTS.md` (update invariant 18)

**Cluster 3 — `image` field type**
- Modify: `packages/shared/src/index.ts` (`FieldType` union)
- Modify: `apps/server/src/lib/field-type-change.ts` (`FIELD_TYPES` const)
- Modify: `apps/web/src/lib/api/fields.ts` (web `FieldType` union)
- Modify: `apps/server/src/routes/fields.ts` (`validateOptions` for `image` if needed)
- Modify: `packages/shared/src/field-infer.ts` (optional: infer `image` from known-image-extension URLs)
- Modify: `apps/web/src/components/slideover/field-renderer.tsx` (the `image` case)
- Modify: `apps/web/src/components/slideover/frontmatter-form.tsx` (field-create type list)

**Cluster 2a — group-summary endpoint + shared types** (FULL)
- Create: `apps/server/src/lib/group-summary.ts` (the aggregate-spec validator — mirrors `filterCompile`'s whitelist/cap pattern — + the SQL builder)
- Create: `apps/server/src/services/group-summary.ts` (the GROUP BY query, project-scoped, filter-compiler reuse)
- Modify: `apps/server/src/routes/documents.ts` (add `GET /group-summary` under the existing `documentsRoute`, inheriting `pScope`)
- Modify: `packages/shared/src/index.ts` (the `AggregateSpec` / `GroupSummaryRequest` / `GroupSummaryResponse` types + the `AGGREGATIONS` whitelist; the `views.settings` grouped-list shape: `groupBy`, `aggregates[]`, `rowLayout`)
- Modify: `apps/web/src/lib/api/views.ts` (the `views.settings` grouped-list config type)
- Create: `apps/web/src/lib/api/group-summary.ts` (the `useGroupSummary` query hook)
- Test: `apps/server/src/lib/group-summary.test.ts`, `apps/server/src/services/group-summary.test.ts` (incl. the 247-rows-across-pages correctness test + the whitelist/denial paths)

**Cluster 2b — grouped-list renderer + config UI** (STANDARD)
- Create: `apps/web/src/components/views/grouped-list-view.tsx` (group headers + aggregates + distribution bar + composed rich-rows + no-group bucket + empty state)
- Create: `apps/web/src/components/views/group-aggregate-header.tsx`, `distribution-bar.tsx`, `grouped-list-row.tsx`, `grouped-list-skeleton.tsx`
- Modify: `apps/web/src/components/views/view-router.tsx` (`list` → `<GroupedListView>`)
- Modify: `apps/web/src/components/views/new-view-sheet.tsx` (the group-by picker + aggregate builder + row-layout picker for `list`)
- Modify: `apps/web/src/components/slideover/field-renderer.tsx` (reuse FieldRenderer for the row's field bits — no change beyond import)

**Cluster 4 — Calendar view**
- Create: `apps/web/src/components/views/calendar-view.tsx`
- Create: `apps/web/src/components/views/calendar-grid.ts` (pure month/week date-math)
- Create: `apps/web/src/components/views/calendar-skeleton.tsx`

**Cluster 5 — Timeline view**
- Create: `apps/web/src/components/views/timeline-view.tsx`
- Create: `apps/web/src/components/views/timeline-lanes.ts` (pure lane/placement math)
- Create: `apps/web/src/components/views/timeline-skeleton.tsx`

**Cluster 6 — Gallery view + G3**
- Create: `apps/web/src/components/views/gallery-view.tsx`
- Create: `apps/web/src/components/views/gallery-skeleton.tsx`
- Modify: `apps/web/src/components/shell/main-frame.tsx` (G3: horizontal scroll affordance for the shared view layout)

---

## Enum + type-name consistency (the cross-layer contract)

The view-`type` and field-`type` enums are each duplicated across **three** sites. A new value MUST be added to ALL THREE or the boundary rejects it (validation-vs-use). Use these EXACT spellings:

**View types — `'table' | 'list' | 'kanban' | 'calendar' | 'timeline' | 'gallery'` (SIX members):**
> `table` = the existing spreadsheet renderer (renamed from today's `list`). `list` = the NEW grouped-list renderer. The migration in Task 1.0b backfills existing `list` rows → `table`, then the seed defaults to `table`.
1. `packages/shared/src/index.ts:10` — `export type ViewType = 'table' | 'list' | 'kanban' | 'calendar' | 'timeline' | 'gallery';`
2. `apps/server/src/routes/views.ts` `baseSchema` — `type: z.enum(['table', 'list', 'kanban', 'calendar', 'timeline', 'gallery'])` (+ the `patchSchema` if it re-declares it)
3. `apps/web/src/lib/api/views.ts` — the `View`, `ViewCreate`, `ViewPatch` interfaces' `type` union
4. `apps/server/src/db/schema.ts:363` — `views.type` is `text('type', { enum: [...] })` (type-level only, **no SQL CHECK** — confirmed: `0000`/`0003` CREATE TABLE has no CHECK on `type`, so widening the ENUM is a Drizzle-schema edit, NOT a migration). Add `table`+`calendar`+`timeline`+`gallery` here so `$inferSelect` types stay accurate. **NOTE:** the `list`→`table` *row* backfill (Task 1.0b) IS a real `.sql` migration (an `UPDATE`, not a schema change) — distinct from this enum widen.

**Field types — add `'image'`:**
1. `packages/shared/src/index.ts:15` — `FieldType` union
2. `apps/server/src/lib/field-type-change.ts:1` — `FIELD_TYPES` const tuple
3. `apps/web/src/lib/api/fields.ts:4` — web `FieldType` union

**## Sibling-site audit (run at cluster 1 close for view-type, cluster 2 close for field-type):** grep each repo for the OLD exhaustive literal so no `switch`/`if` silently mishandles the new member:
```
grep -rn "'list' | 'kanban'" apps packages   # find every site that must gain 'table'+new types
grep -rn "type === 'list'\|type: 'list'" apps/web/src apps/server/src   # find spreadsheet-vs-grouped assumptions to re-key to 'table'
grep -rn "list.*kanban" apps/web/src/lib/rail-nav.ts
grep -rn "case 'currency'" apps/web/src/components   # field-renderer switch exhaustiveness
```
Any `switch (view.type)` / `switch (field.type)` with no `default` that compiled before must get the new case or a deliberate `default`.

---

# CLUSTER 1 — renderAs foundation

> The HIGHEST-RISK cluster: it changes routing for EXISTING views. The safety net is (a) back-compat redirects so old URLs never 404, and (b) the existing list + kanban + new-view-sheet + rail-nav test suites staying GREEN with list+kanban behavior UNCHANGED. That green suite IS the behavior-preservation proof — do not change a list/kanban assertion to make the refactor pass.

### Task 1.0: Add the `views.settings` JSON column (migration)

**Files:**
- Modify: `apps/server/src/db/schema.ts` (views table block, ~line 354)
- Create: `apps/server/src/db/migrations/00NN_view_settings.sql`
- Modify: `apps/server/src/db/migrations/meta/_journal.json`
- Test: `apps/server/src/routes/views.test.ts` (settings round-trips)

- [ ] **Step 1: Write the failing test** — create a view with `settings`, read it back.

```ts
// in apps/server/src/routes/views.test.ts
it('persists and returns view.settings JSON', async () => {
  const created = await createView({ name: 'Cal', type: 'list', settings: { dateField: 'due_date' } });
  expect(created.settings).toEqual({ dateField: 'due_date' });
  const list = await listViewsViaApi();
  expect(list.find((v) => v.id === created.id)?.settings).toEqual({ dateField: 'due_date' });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`settings` not on the schema / not accepted).
Run: `cd apps/server && bun test src/routes/views.test.ts`
Expected: FAIL — `settings` undefined or rejected by Zod.

- [ ] **Step 3: Add the column to the Drizzle schema.**

```ts
// apps/server/src/db/schema.ts — inside export const views = sqliteTable('views', { ...
  // Per-view typed config: calendar/timeline pick which date field drives
  // placement; gallery picks the cover image field. Nullable; {} when unset.
  // (Invariant 10: config of the existing `views` entity, not a new table.)
  settings: text('settings', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
```

- [ ] **Step 4: Generate the migration, then HAND-VERIFY the journal.**
Run: `bun run db:generate`
Then open the new `.sql` and confirm it is `ALTER TABLE \`views\` ADD \`settings\` text DEFAULT '{}' NOT NULL;` and that `meta/_journal.json` gained the entry (drizzle's `migrate()` SILENTLY SKIPS files not in the journal — see lessons.md "Drizzle migration journal").

- [ ] **Step 5: Widen the views Zod schema + the View row type to carry settings.**

```ts
// apps/server/src/routes/views.ts — baseSchema, add:
  settings: z.record(z.unknown()).optional(),
// and patchSchema if it re-declares fields. Thread input.settings into the
// insert (default {}) and the patch.
```
```ts
// apps/web/src/lib/api/views.ts — add to View, ViewCreate, ViewPatch:
  settings?: Record<string, unknown> | null;   // View: settings: Record<string, unknown>;
```

- [ ] **Step 6: Run tests — expect PASS.**
Run: `cd apps/server && bun test src/routes/views.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit.**
```bash
git add apps/server/src/db apps/server/src/routes/views.ts apps/web/src/lib/api/views.ts
git commit -m "phase-6: add views.settings JSON column for per-view config"
```

**Test tier:** Tier A — schema + boundary persistence + JSON round-trip (data-layer). Test contract: asserts `settings` survives create→read AND that an unknown key is preserved (no schema strip).

### Task 1.0b: Backfill existing `list` rows → `table`; seed default becomes `table` (data migration)

> WHY: today the seeded default view is `type:'list'` and renders the spreadsheet. Phase 6 repurposes `list` to mean the NEW grouped list. Without this backfill, every existing project's default view would silently re-render as an unconfigured grouped list. The backfill rewrites all existing `list` rows to the new `table` type (which keeps rendering the spreadsheet), and the seed switches to `table` for new projects. This is the reason Cluster 1 is FULL tier.

**Files:**
- Create: `apps/server/src/db/migrations/00NN_backfill_list_to_table.sql` (+ `_journal.json`)
- Modify: `apps/server/src/lib/seed-project-defaults.ts` (default view `type:'list'` → `'table'`)
- Test: `apps/server/src/db/migrations/00NN.test.ts` (backfill against a NON-EMPTY seeded table — see lessons.md "Fail-loud migration guards"); `apps/server/src/lib/seed-project-defaults.test.ts` (seed creates a `table` default)

- [ ] **Step 1: Write the failing tests.** (a) seed a `views` row with `type='list'`, run the migration, assert it is now `type='table'` AND a `type='kanban'`/already-`table` row is untouched; (b) `seedProjectDefaults` produces a default view of `type:'table'` (NOT `'list'`).
> CRITICAL (lessons.md): test the migration against a PRE-SEEDED non-empty table, and apply the migration via `sqlite.exec(readFileSync(<migration>))` after the migrator runs once (drizzle `migrate()` is idempotent — see "Drizzle migrate() is idempotent"). Split on `--> statement-breakpoint` if multi-statement (bun:sqlite `exec` no-ops a guard otherwise).

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Write the migration.** A pure `UPDATE`, no schema change (the enum widen in Task 1.1 adds `table` to the type-level enum; this row UPDATE must run AFTER `table` is a valid value — order the journal so 1.1's schema enum is in place, OR since there is NO SQL CHECK on `views.type` (confirmed) the UPDATE is valid regardless of enum order — verify by running it).

```sql
-- 00NN_backfill_list_to_table.sql
UPDATE `views` SET `type` = 'table' WHERE `type` = 'list';
```
HAND-VERIFY the `_journal.json` gained the entry (drizzle silently skips un-journaled files).

- [ ] **Step 4: Change the seed** default view `type: 'list'` → `type: 'table'` in `seed-project-defaults.ts`.
- [ ] **Step 5: Run — expect PASS;** run the full server suite (the migration + seed are foundational).
- [ ] **Step 6: Commit.**
```bash
git add apps/server/src/db apps/server/src/lib/seed-project-defaults.ts
git commit -m "phase-6: backfill list→table view rows; seed default view is now table"
```

**Test tier:** Tier A — a data migration that rewrites existing rows (the FULL-tier trigger). Test contract: asserts `list`→`table` for existing rows, `kanban`/`table` untouched, the seed default is `table`, and the migration is correct against a NON-EMPTY table.

### Task 1.1: Widen the view-type enum across all 4 sites (add `table` + calendar/timeline/gallery)

**Files:**
- Modify: `packages/shared/src/index.ts:10`
- Modify: `apps/server/src/db/schema.ts` (`views.type` enum)
- Modify: `apps/server/src/routes/views.ts` (`baseSchema`/`patchSchema` `z.enum`)
- Modify: `apps/web/src/lib/api/views.ts` (`View`/`ViewCreate`/`ViewPatch`)
- Test: `apps/server/src/routes/views.test.ts`

- [ ] **Step 1: Write the failing test** — creating a `calendar` view is accepted.

```ts
it('accepts the new view types (table/calendar/timeline/gallery)', async () => {
  for (const type of ['table', 'calendar', 'timeline', 'gallery'] as const) {
    const v = await createView({ name: type, type });
    expect(v.type).toBe(type);
  }
});
```
> `table` MUST be accepted (it is the renamed spreadsheet type the seed + backfill now write). `list` stays accepted (it is now the grouped-list type).

- [ ] **Step 2: Run it — expect FAIL** (Zod `z.enum(['list','kanban'])` rejects with 422).
Run: `cd apps/server && bun test src/routes/views.test.ts`
Expected: FAIL — 422 INVALID_BODY.

- [ ] **Step 3: Add the FOUR values (`table`, `calendar`, `timeline`, `gallery`) to all four enum sites** (exact spellings in the "Enum consistency" section above): shared `ViewType`, `schema.ts` `views.type` enum array, `views.ts` `z.enum`, web `views.ts` unions. (`list`+`kanban` were already present.)

- [ ] **Step 4: Run tests — expect PASS.**
Run: `cd apps/server && bun test src/routes/views.test.ts && cd ../../packages/shared && bun test`
Expected: PASS.

- [ ] **Step 5: Typecheck all three packages** (no root tsconfig).
Run: `cd apps/server && bun x tsc --noEmit && cd ../web && bun x tsc --noEmit && cd ../../packages/shared && bun x tsc --noEmit`
Expected: clean. Fix any `switch (view.type)` exhaustiveness errors surfaced.

- [ ] **Step 6: Commit.**
```bash
git add packages/shared/src/index.ts apps/server/src/db/schema.ts apps/server/src/routes/views.ts apps/web/src/lib/api/views.ts
git commit -m "phase-6: widen view-type enum to table/calendar/timeline/gallery (all 4 sites)"
```

**Test tier:** Tier A — boundary validation enum (validation-vs-use; a new type rejected at the wire is the exact failure class). Test contract: asserts each new type is ACCEPTED at the create boundary AND an unknown type is still REJECTED 422.

### Task 1.2: `useActiveView` + `<ViewRouter>` (renderer convergence point)

**Files:**
- Create: `apps/web/src/lib/api/use-active-view.ts`
- Create: `apps/web/src/components/views/view-router.tsx`
- Test: `apps/web/src/components/views/view-router.test.tsx`

- [ ] **Step 1: Write the failing test** — `<ViewRouter>` renders TableView for a list view, KanbanView for a kanban view, and a graceful "unsupported" fallback for an unknown type.

```tsx
// view-router.test.tsx (vitest)
import { render, screen } from '@testing-library/react';
import { ViewRouter } from './view-router.tsx';
// mock useActiveView to return a fixed view; mock TableView/KanbanView to markers
vi.mock('./use-active-view.ts', () => ({ useActiveView: vi.fn() }));
// ...
it('routes table → TableView, kanban → KanbanView, list → grouped-list', () => {
  (useActiveView as Mock).mockReturnValue({ view: { id: 'v1', type: 'table' }, isLoading: false });
  render(<ViewRouter wslug="w" pslug="p" tslug="work-items" />);
  expect(screen.getByTestId('table-view-marker')).toBeInTheDocument();   // type:'table' → TableView
});
```

- [ ] **Step 2: Run it — expect FAIL** (files don't exist).
Run: `cd apps/web && npx vitest run src/components/views/view-router.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `useActiveView`** — resolve the active view from `?view=` against the table's `useViews` list, falling back to the table's default view.

```ts
// apps/web/src/lib/api/use-active-view.ts
import { useSearch } from '@tanstack/react-router';
import { type View, useViews } from './views.ts';

/** THE resolver for "which saved view is active on this table". Reads `?view=<id>`;
 *  falls back to the table's isDefault view, else the first view. Sibling to
 *  invariant 18's useCurrentTslug — current-VIEW where that is current-TABLE. */
export function useActiveView(wslug: string, pslug: string, tslug: string): {
  view: View | undefined;
  views: View[];
  isLoading: boolean;
} {
  const search = useSearch({ strict: false }) as { view?: string };
  const { data: views, isLoading } = useViews(wslug, pslug, tslug);
  const list = views ?? [];
  const active =
    (search.view ? list.find((v) => v.id === search.view) : undefined) ??
    list.find((v) => v.isDefault) ??
    list[0];
  return { view: active, views: list, isLoading };
}
```

- [ ] **Step 4: Implement `<ViewRouter>` + the `viewRendererFor` convergence map.**

```tsx
// apps/web/src/components/views/view-router.tsx
import type { ViewType } from '@folio/shared';
import { TableView } from '../table/table-view.tsx';
import { KanbanView } from './kanban-view.tsx';
import { useActiveView } from '../../lib/api/use-active-view.ts';

interface RendererProps { wslug: string; pslug: string; tslug: string; }

/** THE single place that maps a view type → its renderer (invariant 18, renderer
 *  half). A second `switch (view.type)` that picks a component anywhere else is a
 *  bug — add the case HERE. `table` = the existing spreadsheet; `list` = the NEW
 *  grouped-list (cluster 2b). list/calendar/timeline/gallery start as placeholders
 *  and are filled in by clusters 2b/4/5/6. */
const viewRendererFor: Record<ViewType, (p: RendererProps) => JSX.Element> = {
  table: (p) => <TableView {...p} />,                            // the existing spreadsheet
  list: (p) => <UnsupportedView type="list" {...p} />,           // cluster 2b (grouped list)
  kanban: (p) => <KanbanView {...p} />,
  calendar: (p) => <UnsupportedView type="calendar" {...p} />,   // cluster 4
  timeline: (p) => <UnsupportedView type="timeline" {...p} />,   // cluster 5
  gallery: (p) => <UnsupportedView type="gallery" {...p} />,     // cluster 6
};

export function ViewRouter({ wslug, pslug, tslug }: RendererProps) {
  const { view, isLoading } = useActiveView(wslug, pslug, tslug);
  if (isLoading) return <div className="p-8 text-fg-3">Loading view…</div>;
  // No view yet (table with zero views) → default to the TABLE (spreadsheet)
  // render so the table is never blank; the seed always creates a default
  // `table` view, so this is the mid-migration / brand-new-table edge.
  const type = (view?.type ?? 'table') as ViewType;
  return viewRendererFor[type]({ wslug, pslug, tslug });
}

function UnsupportedView({ type }: RendererProps & { type: string }) {
  return <div data-testid={`unsupported-${type}`} className="p-8 text-fg-3">The {type} view is coming soon.</div>;
}
```
(Add `data-testid="table-view-marker"`/`kanban-view-marker` only if the existing components lack a stable test hook; prefer mocking in the test.)

- [ ] **Step 5: Run tests — expect PASS.**
Run: `cd apps/web && npx vitest run src/components/views/view-router.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit.**
```bash
git add apps/web/src/lib/api/use-active-view.ts apps/web/src/components/views/view-router.tsx apps/web/src/components/views/view-router.test.tsx
git commit -m "phase-6: ViewRouter + useActiveView (renderer convergence point, inv 18)"
```

**Test tier:** Tier A — the renderer-resolution decision is the new convergence point; a wrong mapping sends a `table` view to the wrong renderer. Test contract: asserts `table`→TableView, `kanban`→KanbanView, `list`→the grouped-list placeholder, AND an unknown/new type renders the fallback (not a crash).

### Task 1.3: Unified route renders `<ViewRouter>`; old routes redirect

**Files:**
- Modify: `apps/web/src/routes/w.$wslug.p.$pslug.t.$tslug.tsx`
- Modify: `apps/web/src/routes/w.$wslug.p.$pslug.work-items.tsx`
- Modify: `apps/web/src/routes/w.$wslug.p.$pslug.board.tsx`
- Modify: `apps/web/src/routes/w.$wslug.p.$pslug.t.$tslug.board.tsx`
- Test: `apps/web/src/routes/t-tslug.test.tsx` (extend) + new redirect assertions

- [ ] **Step 1: Write the failing redirect tests** — visiting `/work-items` and `/board` resolves to the unified route without a 404.

```tsx
// assert via the route's beforeLoad redirect: the loader throws redirect(...) to
// /t/work-items, carrying ?view= when present. Use TanStack's createMemoryRouter
// or assert the redirect target object the beforeLoad returns.
it('work-items route redirects to /t/work-items preserving ?view=', () => {
  const target = workItemsBeforeLoad({ params: { wslug: 'w', pslug: 'p' }, search: { view: 'v1' } });
  expect(target).toMatchObject({ to: '/w/$wslug/p/$pslug/t/$tslug', params: { tslug: 'work-items' }, search: { view: 'v1' } });
});
```

- [ ] **Step 2: Run — expect FAIL** (routes still render components directly).
Run: `cd apps/web && npx vitest run src/routes/t-tslug.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Unified route renders `<ViewRouter>`.**

```tsx
// apps/web/src/routes/w.$wslug.p.$pslug.t.$tslug.tsx
import { createFileRoute } from '@tanstack/react-router';
import { ViewRouter } from '../components/views/view-router.tsx';
import { tableSearchSchema } from '../lib/table-search.ts';

export const Route = createFileRoute('/w/$wslug/p/$pslug/t/$tslug')({
  validateSearch: tableSearchSchema,   // must accept `view` (already does) + filter keys
  component: TableRoute,
});

function TableRoute() {
  const { wslug, pslug, tslug } = Route.useParams();
  return <ViewRouter wslug={wslug} pslug={pslug} tslug={tslug} />;
}
```

- [ ] **Step 4: The three legacy routes become redirects** (back-compat — old URLs MUST NOT 404).

```tsx
// w.$wslug.p.$pslug.work-items.tsx
import { createFileRoute, redirect } from '@tanstack/react-router';
import { DEFAULT_TABLE_SLUG } from '../lib/default-table.ts';
import { tableSearchSchema } from '../lib/table-search.ts';

export const Route = createFileRoute('/w/$wslug/p/$pslug/work-items')({
  validateSearch: tableSearchSchema,
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: '/w/$wslug/p/$pslug/t/$tslug',
      params: { ...params, tslug: DEFAULT_TABLE_SLUG },
      search,
    });
  },
});
```
```tsx
// w.$wslug.p.$pslug.board.tsx — same, but ALSO needs to land on a KANBAN view.
// A bare /board carried no view id. Redirect to the default table; the board
// CASE is preserved by routing to the table's default KANBAN view if one exists,
// else /t/$tslug (list). Simplest correct behavior: redirect to /t/$tslug with
// no ?view= (ViewRouter falls to the default view). If preserving "board lands
// on a board" matters, carry search through and let the user's saved default
// view decide — document this as the accepted back-compat behavior.
beforeLoad: ({ params, search }) => {
  throw redirect({ to: '/w/$wslug/p/$pslug/t/$tslug', params: { ...params, tslug: DEFAULT_TABLE_SLUG }, search });
},
```
```tsx
// w.$wslug.p.$pslug.t.$tslug.board.tsx — redirect to /t/$tslug (param preserved).
beforeLoad: ({ params, search }) => {
  throw redirect({ to: '/w/$wslug/p/$pslug/t/$tslug', params, search });
},
```
> **Behavior-preservation note (board back-compat):** the old `/board` URLs no longer guarantee a kanban RENDER — they land on the table's active/default view. This is the accepted, documented behavior change of the NocoDB model (type lives on the view, not the URL). If a user wants a board, they select a kanban saved view. Call this out at the review gate; do NOT add a synthetic kanban-pinning param to "preserve" it — that re-introduces the URL-as-type coupling Option B exists to remove.

- [ ] **Step 5: Run tests — expect PASS; then run the FULL list+kanban suites (behavior-preservation).**
Run: `cd apps/web && npx vitest run src/routes src/components/views src/components/table`
Expected: PASS, with list-view + kanban-view assertions UNCHANGED. If a list/kanban test now fails, the refactor changed behavior — fix the refactor, not the test.

- [ ] **Step 6: Commit.**
```bash
git add apps/web/src/routes
git commit -m "phase-6: unified /t/\$tslug renders ViewRouter; legacy URLs redirect (no 404)"
```

**Test tier:** Tier A — the redirect logic is the back-compat safety net (a wrong redirect 404s every bookmarked URL). Test contract: asserts each legacy URL redirects to the unified route preserving search params, AND the unified route mounts ViewRouter.

### Task 1.4: new-view-sheet offers all 5 types; routes to unified

**Files:**
- Modify: `apps/web/src/components/views/new-view-sheet.tsx`
- Test: `apps/web/src/components/views/new-view-sheet.test.tsx`

- [ ] **Step 1: Write the failing test** — the sheet renders 5 type radios and creating a `calendar` view navigates to the unified route with `?view=<id>`.

```tsx
it('offers all five view types', () => {
  render(<NewViewSheet open wslug="w" pslug="p" tslug="work-items" currentSearch={{}} onOpenChange={()=>{}} />);
  for (const t of ['List','Kanban','Calendar','Timeline','Gallery']) expect(screen.getByLabelText(t)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run — expect FAIL** (only List/Kanban today).
Run: `cd apps/web && npx vitest run src/components/views/new-view-sheet.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Replace the two-radio fieldset with a 5-type picker** and widen the `type` state.

```tsx
const VIEW_TYPES = [
  { value: 'list', label: 'List' },
  { value: 'kanban', label: 'Kanban' },
  { value: 'calendar', label: 'Calendar' },
  { value: 'timeline', label: 'Timeline' },
  { value: 'gallery', label: 'Gallery' },
] as const;
type NewViewType = (typeof VIEW_TYPES)[number]['value'];
const [type, setType] = useState<NewViewType>('list');
// reset in the !open effect: setType('list');
```
Render `VIEW_TYPES.map(...)` as the radios (keep the `name="view-type"` group). The group-by select stays gated on `type === 'kanban'`. For calendar/timeline add a "date field" select and for gallery a "cover image field" select, written into `payload.settings` (see clusters 3/4/5 for the exact keys — at this task they may be omitted; the views default `settings` to `{}` and the view's own toolbar picks the field). Keep it minimal here: just the type radios + route.

- [ ] **Step 4: Route to the unified route** — `resolveViewNav` now returns the unified target for ALL types (see Task 1.5). The existing `navigate({ to: target.to, ... })` call is unchanged once `resolveViewNav` is updated.

- [ ] **Step 5: Run tests — expect PASS.**
Run: `cd apps/web && npx vitest run src/components/views/new-view-sheet.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit.**
```bash
git add apps/web/src/components/views/new-view-sheet.tsx apps/web/src/components/views/new-view-sheet.test.tsx
git commit -m "phase-6: new-view sheet offers all 5 view types"
```

**Test tier:** Tier B — presentational picker over an already-tested create mutation + already-tested nav resolver. `no unit test: Tier B, glue over tested mutation` would apply EXCEPT the 5-type enumeration is a spec contract — keep ONE light render test asserting all five radios exist (the spec-coverage guard), no logic test.

### Task 1.5: `resolveViewNav` → unified route for all types

**Files:**
- Modify: `apps/web/src/lib/rail-nav.ts`
- Test: `apps/web/src/lib/rail-nav.test.ts` (create if absent; there are nav tests referenced by invariant 18 consumers)

- [ ] **Step 1: Write the failing test** — `resolveViewNav` returns the unified `/t/$tslug` target (with `view` carried by the caller) for every type, including the default table.

```ts
import { resolveViewNav } from './rail-nav.ts';
it('routes all view types to the unified table route', () => {
  expect(resolveViewNav('work-items', 'calendar')).toEqual({ to: '/w/$wslug/p/$pslug/t/$tslug', withTslug: true });
  expect(resolveViewNav('bugs', 'kanban')).toEqual({ to: '/w/$wslug/p/$pslug/t/$tslug', withTslug: true });
});
```
> Note: this makes the DEFAULT table also route through `/t/$tslug` (no more `/work-items`/`/board` for view clicks — those are redirect-only now). `resolveViewNav` no longer special-cases the default table OR the kanban type.

- [ ] **Step 2: Run — expect FAIL** (current impl special-cases default + kanban).
Run: `cd apps/web && npx vitest run src/lib/rail-nav.test.ts`
Expected: FAIL.

- [ ] **Step 3: Simplify `resolveViewNav`** — type-agnostic, always unified. Update its signature to accept the full `ViewType` (not `'list' | 'kanban'`).

```ts
import type { ViewType } from '@folio/shared';
/** Where a VIEW-row click lands: ALWAYS the unified table route. The view's
 *  TYPE is decided by ViewRouter from the saved view, not the URL (Option B,
 *  Phase 6). The caller carries `search: { view: id }`. Legacy /work-items +
 *  /board are redirect-only (back-compat). */
export function resolveViewNav(tslug: string, _type: ViewType): RailNavTarget {
  return { to: '/w/$wslug/p/$pslug/t/$tslug', withTslug: true };
}
```
> Keep the `_type` param for call-site compatibility; mark it unused. `resolveTableNav` likewise should now route the default table to `/t/$tslug` too — OR leave `resolveTableNav` as-is if a table-row click should still hit the default table's unified route. Decide and make both consistent: a table click and a view click on the same table should land the same place. Recommend: `resolveTableNav` ALSO returns `{ to: '/w/$wslug/p/$pslug/t/$tslug', withTslug: true }` for every table (the default table's `/work-items` redirect handles old bookmarks).

- [ ] **Step 4: Update `activeTableFromPath`/`activeTabFromPath`** — the `/work-items|/board` path arms can stay (they still match a freshly-redirected URL only momentarily); but `activeTabFromPath` (grid-vs-board) is now MEANINGLESS under the view model. Replace the project-layout tab logic in Task 1.6; here just ensure `activeTableFromPath` still resolves the default table for a bare `/t/work-items`.

- [ ] **Step 5: Run tests — expect PASS; run the full nav + rail suite.**
Run: `cd apps/web && npx vitest run src/lib/rail-nav.test.ts src/routes/w.\$wslug.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit.**
```bash
git add apps/web/src/lib/rail-nav.ts apps/web/src/lib/rail-nav.test.ts
git commit -m "phase-6: resolveViewNav routes all view types to unified route (inv 18)"
```

**Test tier:** Tier A — invariant-18 navigation branch; a wrong target sends a view click to the wrong table/route. Test contract: asserts every (table, type) pair resolves to the unified route, default table included.

### Task 1.6: Project-layout tabs → saved-view switcher; fold in G4 toggle

**Files:**
- Modify: `apps/web/src/routes/w.$wslug.p.$pslug.tsx`
- Modify: `apps/web/src/components/shell/main-frame.tsx` (G4: visible operator-panel toggle in the frame toolbar)
- Test: `apps/web/src/routes/w.$wslug.p.$pslug.test.tsx`

- [ ] **Step 1: Write the failing tests** — (a) the project layout renders one tab/chip PER SAVED VIEW (not the fixed Work-items/Board pair), each navigating to the unified route with that view's id; (b) a visible operator-panel toggle button exists in the frame toolbar and calls `agentPanelBus.toggle()`.

```tsx
it('renders a switcher tab per saved view', () => {
  // mock useViews → [{id:'v1',name:'All',type:'list'},{id:'v2',name:'Board',type:'kanban'}]
  render(<ProjectLayout/>);
  expect(screen.getByRole('tab', { name: /All/ })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: /Board/ })).toBeInTheDocument();
});
it('shows a visible operator-panel toggle in the toolbar (G4)', () => {
  render(<WorkspaceLayout/>);
  expect(screen.getByRole('button', { name: /operator|assistant|panel/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run — expect FAIL.**
Run: `cd apps/web && npx vitest run src/routes/w.\$wslug.p.\$pslug.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Replace the fixed `TABS` with a saved-view switcher** driven by `useViews(wslug, pslug, tslug)`. Each tab shows the view name + a type icon; clicking navigates `{ to: '/w/$wslug/p/$pslug/t/$tslug', params: { wslug, pslug, tslug }, search: (s) => ({ ...s, view: v.id }) }`. The active tab = `useActiveView(...).view?.id`. Keep the "+ new view" affordance opening the new-view sheet (already wired via the rail / `newViewSheet` state). `BoardControls` renders only when the active view's `type === 'kanban'` (replace the `activeTab === 'board'` condition with `activeView?.type === 'kanban'`).

```tsx
// sketch
const { view: activeView, views } = useActiveView(wslug, pslug, tslug);
// tabs:
{views.map((v) => (
  <FrameTab key={v.id} active={activeView?.id === v.id} icon={iconForViewType(v.type)}
    onClick={() => navigate({ to: '/w/$wslug/p/$pslug/t/$tslug', params: { wslug, pslug, tslug }, search: (s) => ({ ...s, view: v.id }) })}>
    {v.name}
  </FrameTab>
))}
{activeView?.type === 'kanban' ? (<><div .../><BoardControls wslug={wslug} pslug={pslug} tslug={tslug} /></>) : null}
```
Add a small `iconForViewType` helper (list→List, kanban→Columns3, calendar→Calendar, timeline→GanttChart, gallery→Image from lucide).

- [ ] **Step 4: G4 — add a visible operator-panel toggle to the frame toolbar.** In `main-frame.tsx` (or the workspace layout's frame header), render a button that calls `agentPanelBus.toggle()` with an `aria-label="Toggle operator panel"` and a `PanelRight` icon, reflecting `agentPanelBus.get().open` (subscribe via the existing pattern). This is the missing re-open affordance — today the panel can only be toggled from the workspace dropdown + Cmd-K (confirmed in `w.$wslug.tsx`).

- [ ] **Step 5: Run tests — expect PASS; run the full project-layout + workspace suite.**
Run: `cd apps/web && npx vitest run src/routes`
Expected: PASS.

- [ ] **Step 6: Commit.**
```bash
git add apps/web/src/routes/w.\$wslug.p.\$pslug.tsx apps/web/src/components/shell/main-frame.tsx apps/web/src/routes/w.\$wslug.p.\$pslug.test.tsx
git commit -m "phase-6: project tabs become saved-view switcher; add G4 operator-panel toggle"
```

**Test tier:** Tier B for the switcher rendering (presentational over tested hooks) BUT keep ONE render test asserting per-view tabs + the G4 toggle exist (spec contract). The `activeView?.type === 'kanban'` gate is a behavior change worth a single assertion (BoardControls hidden on a list view).

### Task 1.7: Update ARCHITECTURE-INVARIANTS.md (invariant 18)

**Files:**
- Modify: `ARCHITECTURE-INVARIANTS.md` (invariant 18)

- [ ] **Step 1: Amend invariant 18** to name the new renderer-resolution convergence point and the retired URL-as-type branch:
  - Add: "`<ViewRouter>` + the `viewRendererFor` map (`apps/web/src/components/views/view-router.tsx`) is the SINGLE place a view `type` → renderer is decided. A second `switch (view.type)` picking a component is a bug."
  - Add: "Which SAVED VIEW is active is `useActiveView` (`apps/web/src/lib/api/use-active-view.ts`) — the current-VIEW twin of `useCurrentTslug`'s current-TABLE."
  - Amend the `resolveViewNav` clause: it now routes ALL view clicks to the unified `/t/$tslug?view=<id>`; the per-type `/board` branch is retired; legacy `/work-items`+`/board` are redirect-only back-compat.
- [ ] **Step 2: Run the traceability check.**
Run: `bun run check:invariants`
Expected: exit 0 — the cited files/symbols (`view-router.tsx`/`ViewRouter`/`viewRendererFor`, `use-active-view.ts`/`useActiveView`) resolve.
- [ ] **Step 3: Commit.**
```bash
git add ARCHITECTURE-INVARIANTS.md
git commit -m "docs(invariants): inv 18 — ViewRouter renderer convergence + useActiveView"
```

**Test tier:** `no unit test: Tier B, documentation` — covered by `check:invariants` traceability.

**Integration gate (Cluster 1):** Run the FULL web suite + all three typechecks. The list + kanban suites pass UNCHANGED = behavior preserved. Manually (or via `superpowers-chrome`) confirm: old `/work-items` and `/board` URLs redirect (no 404); switching saved views swaps the renderer; the G4 toggle opens/closes the operator panel; `bun run check:invariants` is green.

## Acceptance flows — Cluster 1 (view switching + back-compat)

| Flow | Empty/zero-state | Denied actor | Wrong-order/re-entry | Concurrent/double | Boundary value | Mid-flow failure |
|---|---|---|---|---|---|---|
| **Switch between saved views** | Table with only the seeded default view → switcher shows 1 tab, no crash | (single-team; no per-view denial — N/A, no auth boundary on views) | Click the already-active view tab → no-op refetch, stays put | Rapid double-click two view tabs → last `?view=` wins, no torn render | A view whose `?view=` id no longer exists (deleted) → falls back to default view, not blank | `useViews` errors → switcher shows the error toast (formatApiError), table area shows existing error UI |
| **Land on a legacy URL** (`/work-items`, `/board`, `/t/x/board`) | redirect lands on a table with 0 views → ViewRouter list-fallback, not 404 | N/A | Re-visit after redirect (browser back) → re-redirects cleanly, no loop | Two tabs open old + new URL → both resolve to the same unified route | `/board` (no view id) → lands on default view (documented: not guaranteed kanban) | redirect target table slug invalid → existing table-not-found UI, not a white screen |
| **Toggle operator panel (G4)** | Panel never opened before → toggle opens it | N/A | Toggle closed→open→closed → localStorage `folio:cockpit-closed` tracks; reload respects last | Double-click toggle → idempotent (bus.toggle) | — | localStorage unavailable (SSR/test) → accessors no-op, button still renders |

`── REVIEW GATE ──` (tier: **FULL** — touches the DATA LAYER: the `views.settings` schema column + the `list`→`table` row backfill migration + the seed default change (1h FULL trigger). Also touches invariant 18 (UI routing). Behavior-preservation net = existing table/kanban/nav suites green AND the migration correctness test on a non-empty table.) **STOP. Full finder panel + simplicity + security-sentinel (verifying the migration is non-destructive + backfill-correct) + a feature-acceptance browser pass on the switching + redirect flows + a check that existing `list` views still render the spreadsheet (now as `table`).**

---


# CLUSTER 2a — group-summary endpoint + shared types (FULL)

> The new parsing→SQL surface. Build the contract + the threat-model mitigations (1–8) FIRST. This cluster ships NO renderer — it ships the validated, project-scoped, cost-bounded aggregate engine + the shared types the renderer (2b) consumes. The architectural decision (server-side aggregates over the FULL filtered set, NOT client-side over the loaded page) is RESOLVED in favor of the endpoint — see "## Threat model / ## Contract" above and the L.1 247-rows correctness test.

### Task L.1: group-summary validator + service + endpoint (server, Tier A, FULL)

**Files:**
- Create: `apps/server/src/lib/group-summary.ts` (the `validateGroupSummaryRequest` + the `AGGREGATIONS` whitelist + the SQL fragment builder)
- Create: `apps/server/src/services/group-summary.ts` (`groupSummary({ projectId, activeTableId, groupBy, aggregates, filter, type })` — the GROUP BY query)
- Modify: `apps/server/src/routes/documents.ts` (`documentsRoute.get('/group-summary', …)` — inherits `pScope`)
- Modify: `packages/shared/src/index.ts` (export `AggregateSpec`, `AGGREGATIONS`, `GroupSummaryRow`, `DistributionBucket`, `GroupSummaryResponse`)
- Test: `apps/server/src/lib/group-summary.test.ts`, `apps/server/src/services/group-summary.test.ts`

- [ ] **Step 1: Write the failing tests** (RED-first), covering the happy path AND every denial/whitelist path AND the cross-page correctness case:
  - **Aggregate correctness over the FULL set across pages:** seed **247** work_items across a known group field with a known `pct_matching`/`avg`/`sum`/`count`/`distribution`; call group-summary (NO limit); assert the header totals equal the FULL-set totals — NOT a page-1 (50-row) subset. (This is the page-2-bug-class guard — the whole reason the endpoint exists.)
  - **Whitelist denials (mitigations 1–4):** an unknown aggregation op → 422 `INVALID_AGGREGATE`; >10 aggregates → 422; a `groupBy` key failing `/^[a-zA-Z0-9_]+$/` or not a registered field → 422 `INVALID_GROUP_BY`; a `pct_matching` value flows as a bound param (assert it cannot break the query — e.g. value `x' OR '1'='1` yields a correct zero-ish count, not all rows).
  - **Filter reuse (mitigation 5):** a `filter=` narrows the aggregated set; a >8192-byte filter → 422 before parse.
  - **Project scope (mitigation 6):** rows in another project are NOT aggregated.
  - **No-group bucket:** documents missing the `groupBy` field land in the `ungrouped` row.
  - **Group cap / truncation (mitigation 4):** >200 distinct groups → `truncated:true`, ≤200 rows.
  - **Distribution cap (mitigation 8):** a distribution aggregate over >50 distinct values caps to 50 + "other".

```ts
// services/group-summary.test.ts (bun:sqlite, real DB — mirror documents.test.ts setup)
it('aggregates over the FULL filtered set, not a page (247 rows)', async () => {
  await seedWorkItems(247, (i) => ({ status: i < 148 ? 'done' : 'open', att: 90 + (i % 11) }));
  const { groups } = await groupSummary({
    projectId: p.id, groupBy: 'status',
    aggregates: [{ op: 'count' }, { op: 'pct_matching', field: 'status', value: 'done' }, { op: 'avg', field: 'att' }],
  });
  const done = groups.find((g) => g.value === 'done')!;
  expect(done.count).toBe(148);                 // full set, not 50
  expect(done.aggregates['pct_matching:status:done']).toBe(100);
});
it('rejects an unknown aggregation op (422 INVALID_AGGREGATE)', () => {
  expect(() => validateGroupSummaryRequest({ groupBy: 'status', aggregates: [{ op: 'evil' as never }] }))
    .toThrow(/INVALID_AGGREGATE|unknown aggregation/);
});
it('rejects a non-field groupBy key (422 INVALID_GROUP_BY)', () => {
  expect(() => validateGroupSummaryRequest({ groupBy: "x'); DROP", aggregates: [{ op: 'count' }] }))
    .toThrow(/INVALID_GROUP_BY/);
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `cd apps/server && bun test src/lib/group-summary.test.ts src/services/group-summary.test.ts`
- [ ] **Step 3: Implement the validator** (`group-summary.ts`) mirroring `filterCompile` EXACTLY (the proven hardening template): closed `AGGREGATIONS` set (mitigation 1), field-key `/^[a-zA-Z0-9_]+$/` + registered-`fields` check (mitigation 2, reuse the `documents.ts` line-98 pattern), `MAX_AGGREGATES`/`MAX_GROUPS`/`MAX_DISTRIBUTION_BUCKETS` caps (mitigations 3/4/8). Each op → a FIXED SQL fragment; match values bound (`${value}`), never interpolated.
- [ ] **Step 4: Implement the service** — a single `GROUP BY json_extract(frontmatter,'$.<groupBy>')` (or the built-in column) over `WHERE eq(projectId) AND <compileFilterToWhere(filter)>` (mitigations 6/7), with the aggregate fragments in the SELECT; `ORDER BY COUNT(*) DESC LIMIT MAX_GROUPS+1` to detect truncation; a second `GROUP BY g,v` for any `distribution` aggregate (proven feasible on bun:sqlite). NO `limit`/`cursor` on the rows — full-set aggregate.
- [ ] **Step 5: Wire the route** under `documentsRoute` (copies the `documents.ts` GET filter-cap + JSON.parse guard verbatim for mitigation 5; throws the structured 422s).
- [ ] **Step 6: Run — expect PASS** (≥3× for determinism on the seeded aggregates). Run server suite + `bun x tsc --noEmit` (server + shared).
- [ ] **Step 7: Commit.** `git commit -m "phase-6: group-summary endpoint (whitelisted aggregates, full-set, project-scoped)"`

**Test tier:** Tier A — parsing→SQL boundary + a cost/injection guard + a data-correctness contract (the FULL-tier surface). Test contract: asserts each aggregation computes correctly over the FULL set across pages; the op whitelist + field-key validator + caps all DENY (the denial paths are mandatory); the `pct_matching` value is bound (injection-safe); project scope holds.

### Task L.2: shared `views.settings` grouped-list config types + Zod

**Files:**
- Modify: `packages/shared/src/index.ts` (the grouped-list `settings` shape)
- Modify: `apps/web/src/lib/api/views.ts` (web type)
- Modify: `apps/server/src/routes/views.ts` (the `settings` Zod accepts the grouped-list shape — keep it permissive `z.record(z.unknown())` at the boundary, validate the grouped-list shape at READ time in the renderer, so adding a future view type doesn't require a server change)
- Create: `apps/web/src/lib/api/group-summary.ts` (`useGroupSummary(wslug,pslug,tslug,{groupBy,aggregates,filter})` query hook)
- Test: `apps/web/src/lib/api/group-summary.test.ts` (the hook builds the right query string; reuses the api client)

- [ ] **Step 1: Define the grouped-list settings shape** in shared:
```ts
export interface GroupedListSettings {
  groupBy: string;                       // the group field key
  aggregates: AggregateSpec[];           // the per-group summary stats (max 10)
  rowLayout: { primary: string; subtitle?: string; fields: string[] };  // composed-row config
}
```
- [ ] **Step 2: Implement `useGroupSummary`** — a react-query hook keyed on `(tslug, groupBy, aggregates, filter)`; calls the L.1 endpoint; staleTime moderate. KEEP it OUT of the shared `entityKeys.all` prefix (lessons.md "react-query prefix-invalidation ignores staleTime" — a seed query under the shared prefix remounts mid-flow).
- [ ] **Step 3: Run — expect PASS.** typecheck all three.
- [ ] **Step 4: Commit.** `git commit -m "phase-6: grouped-list settings types + useGroupSummary hook"`

**Test tier:** Tier A for the hook's query-string construction (it must pass `aggregates`/`filter` correctly — a wrong serialization silently mis-aggregates). The shared type is `no unit test: Tier B, a type declaration`. Test contract: the hook serializes `aggregates`+`filter` into the documented query params.

**Integration gate (Cluster 2a):** Full server + shared suites + both typechecks. **Backend feature-acceptance through the UN-MOCKED wire:** `curl` the live `group-summary` endpoint against the dev server with (a) a valid spec → correct full-set totals, (b) an unknown op → 422 `INVALID_AGGREGATE`, (c) a 250-group field → `truncated:true`. Run the **## Sibling-site audit** for the aggregation whitelist: grep that NO op string reaches SQL outside the `AGGREGATIONS`-mapped fragments.

## Acceptance flows — Cluster 2a (group-summary endpoint, backend/wire)

| Flow | Empty/zero-state | Denied actor | Wrong-order/re-entry | Concurrent/double | Boundary value | Mid-flow failure |
|---|---|---|---|---|---|---|
| **Compute group summary** (un-mocked wire) | 0 docs in project → `{groups:[], ungrouped:null, truncated:false}`, 200 not 500 | External (no session/token) → 401/403 via pScope; cross-project rows excluded | Re-query same spec → identical totals (deterministic) | Two concurrent queries → independent, no shared state | 247 rows across pages → header totals = FULL set, not page-1; 201 groups → `truncated:true` | Malformed `aggregates` JSON → 422 INVALID_AGGREGATE, never a 500 |
| **Reject a hostile spec** | — | A bound `pct_matching` value `x' OR '1'='1` → counted as a literal, NOT all rows | Unknown op then valid op → first 422, second 200 (no poisoned cache) | — | >10 aggregates / >8192-byte filter / bad groupBy key → 422 at the boundary | — |

`── REVIEW GATE ──` (tier: **FULL** — a NEW parsing→SQL surface (client spec → GROUP BY json_extract), the same class as the M3 `$contains` finding. security-sentinel + full finder panel verify the threat-model mitigations 1–8.) **STOP. Full finder panel + simplicity + security-sentinel against the group-summary threat model + the backend wire acceptance pass (curl the un-mocked endpoint).**

---

# CLUSTER 2b — grouped-list renderer + config UI (STANDARD)

> The user-facing grouped list. Consumes the (already-hardened) Cluster-2a endpoint. Reuses FilterBar, FieldRenderer (for the composed-row field bits), DocumentSlideover (`?doc=`), EmptyState. No new server/security surface of its own.

### Task L.3: `GroupedListView` — grouped cards + aggregate headers + distribution bar + no-group bucket

**Files:**
- Create: `apps/web/src/components/views/grouped-list-view.tsx`, `group-aggregate-header.tsx`, `distribution-bar.tsx`, `grouped-list-row.tsx`, `grouped-list-skeleton.tsx`
- Test: `apps/web/src/components/views/grouped-list-view.test.tsx`

- [ ] **Step 1: Write failing tests** — renders one group section per `useGroupSummary` group with its header (group value · N items · the configured aggregates); renders the distribution bar for a `distribution` aggregate; renders composed rich-rows (primary + subtitle + the `rowLayout.fields` via FieldRenderer) from the paginated `useDocuments`; a "no group" bucket at the BOTTOM for the `ungrouped` rows; EmptyState when 0 docs; clicking a row → `?doc=<slug>`; a `truncated` summary shows "+N more groups". Mock `useGroupSummary`/`useDocuments`/`useActiveView`/`useFields` like `kanban-view.test.tsx`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `GroupedListView({wslug,pslug,tslug})`: read `useActiveView` → `settings` (the `GroupedListSettings`; default `groupBy:'status'`, `aggregates:[{op:'count'}]`, `rowLayout` from the first few fields); `useGroupSummary(...)` for the headers (full-set) + `useDocuments(... limit:50, cursor)` for the rows (paginated); group the loaded rows by the same `groupBy` value CLIENT-SIDE for DISPLAY placement only (NOT for the aggregate totals — those come from the endpoint); render `GroupAggregateHeader` + `DistributionBar` + `GroupedListRow`; the `ungrouped` bucket last; FilterBar reuse (the SAME filter feeds both the rows query and the group-summary query so they stay consistent); EmptyState; skeleton; "Toont 1–N van TOTAL" pager from the documents query metadata.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.** `git commit -m "phase-6: grouped-list view (group headers, aggregates, distribution bar, no-group bucket)"`

**Test tier:** Tier B rendering shell over the Tier-A endpoint + tested hooks — keep render-presence assertions for the group headers, an aggregate value, the distribution bar, the no-group bucket, and EmptyState (spec contract). The ONE Tier-A slice worth a dedicated assertion: the group HEADER total comes from `useGroupSummary` (full set), NOT from a client count of the loaded rows (assert that with 5 loaded rows but a summary count of 148, the header shows 148 — the page-2-bug-class guard at the UI layer).

### Task L.4: grouped-list config UI (group-by picker + aggregate builder + row-layout picker)

**Files:**
- Modify: `apps/web/src/components/views/new-view-sheet.tsx` (the `list`-type config block)
- Create: `apps/web/src/components/views/grouped-list-config.tsx` (reused by new-view + an edit-view affordance)
- Test: `apps/web/src/components/views/grouped-list-config.test.tsx`

- [ ] **Step 1: Write failing tests** — when the new-view type is `list`, the sheet shows: a group-by `<select>` (the project fields), an aggregate builder (add a row = pick field + pick aggregation op from the whitelist; the `pct_matching` op reveals a value input), and a row-layout picker (primary/subtitle selects + a multi-select of which fields render in the row). Creating the view writes the assembled `GroupedListSettings` into `payload.settings`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `GroupedListConfig` driven by `useFields`; the aggregation `<select>` lists ONLY the whitelisted ops (`count`/`pct_matching`/`avg`/`sum`/`distribution`) — the SAME list the server enforces (a sibling-site of the `AGGREGATIONS` whitelist; note it in the audit); assemble + validate `GroupedListSettings`; thread into the create mutation's `settings`. The new-view sheet (already touched in Task 1.4) renders this block only when `type==='list'`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.** `git commit -m "phase-6: grouped-list config UI (group-by, aggregate builder, row-layout)"`

**Test tier:** Tier B for the picker rendering over the tested create mutation — keep render-presence assertions for the group-by select, the aggregate builder (add/remove an aggregate), the `pct_matching` value reveal, and the row-layout picker (spec contract). The assembled-`settings` payload shape is the one behavior worth a single assertion (Tier-A slice): creating with two aggregates writes both into `settings.aggregates`.

### Task L.5: wire `list` → GroupedListView in the router

**Files:**
- Modify: `apps/web/src/components/views/view-router.tsx`
- Test: `apps/web/src/components/views/view-router.test.tsx` (extend)

- [ ] **Step 1:** Router test — `type:'list'` renders the grouped-list marker (not the placeholder).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3:** Replace the `list` placeholder line in `viewRendererFor` with `(p) => <GroupedListView {...p} />`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.** `git commit -m "phase-6: wire GroupedListView into ViewRouter"`

**Test tier:** Tier A — the convergence-map wiring. Contract: `list` → GroupedListView.

**Integration gate (Cluster 2b):** Full web suite + typecheck. **Browser feature-acceptance:** create a `list` view, configure group-by + a `pct_matching` + an `avg` + a distribution aggregate; see grouped sections with correct headers; confirm the header total is the FULL-group total while the rows are paginated ("Toont 1–10 van 247" with a header count >10); the no-group bucket holds date-less/group-less rows; changing the group-by re-summarizes; FilterBar narrows both rows and headers consistently.

## Acceptance flows — Cluster 2b (grouped list, UI through the real browser)

| Flow | Empty/zero-state | Denied actor | Wrong-order/re-entry | Concurrent/double | Boundary value | Mid-flow failure |
|---|---|---|---|---|---|---|
| **Render a grouped list** | 0 docs → EmptyState (no empty group shells) | N/A (single-team) | Change group-by then back → re-summarizes both times, no stale headers | Two tabs, one reschedules a row → both reflect new group counts after refetch | **247 rows paginated** → group HEADER totals = full-group (148 done), rows show page-1 only ("van 247") — the page-2-bug-class case, driven for real | `useGroupSummary` errors → header shows an error affordance, rows still render (graceful) |
| **No-group bucket** | All rows have the group field → bucket hidden | N/A | Clear a row's group field → it moves to the no-group bucket on refetch | — | A row whose group value is empty-string vs null → both land in the no-group bucket consistently | — |
| **Configure aggregates** | No aggregates configured → headers show just "N items" | N/A | Add then remove an aggregate → header updates | Add a `pct_matching` then change its value → re-summarizes | A `distribution` over a select field → the colored bar matches the per-group breakdown | A whitelist-rejected aggregate spec can't be built in the UI (the op select is the whitelist); a hand-crafted bad spec → endpoint 422, surfaced as a toast |

`── REVIEW GATE ──` (tier: STANDARD — a UI feature consuming the already-hardened 2a endpoint; no 1a surface of its own. Escalate to FULL only if review finds the renderer re-deriving aggregates client-side over a page (the page-2 bug) or sending an unvalidated spec.) **STOP. 2 finders + simplicity + a feature-acceptance browser pass driving the three grouped-list flows (incl. the 247-rows full-vs-page header case).**

---

# CLUSTER 3 — `image` field type

> Additive, lower-risk. The one security ask is a client-side scheme check (see the image-field mini-assessment above). The cross-layer enum (3 sites) is the validation-vs-use surface.

### Task 2.1: Add `'image'` to the field-type enum (all 3 sites)

**Files:**
- Modify: `packages/shared/src/index.ts:15` (`FieldType` union)
- Modify: `apps/server/src/lib/field-type-change.ts:1` (`FIELD_TYPES`)
- Modify: `apps/web/src/lib/api/fields.ts:4` (web `FieldType`)
- Test: `apps/server/src/routes/fields.test.ts`

- [ ] **Step 1: Write the failing test** — creating an `image` field is accepted; changing `image → number` is rejected, `image → text` allowed.

```ts
it('accepts image field type', async () => {
  const f = await createField({ key: 'cover', type: 'image' });
  expect(f.type).toBe('image');
});
it('image type-change: → text allowed, → number rejected', () => {
  expect(validateTypeChange('image', 'text').ok).toBe(true);
  expect(validateTypeChange('image', 'number').ok).toBe(false);
});
```

- [ ] **Step 2: Run — expect FAIL** (enum rejects `image`).
Run: `cd apps/server && bun test src/routes/fields.test.ts src/lib/field-type-change.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add `'image'`** to all three enum sites. No `validateTypeChange` change needed beyond the enum widen — `image` falls into the default "incompatible" branch (only `any→text` is allowed, which already covers `image→text`). No `COMPATIBLE_PAIRS` entry.

- [ ] **Step 4: Run tests + typecheck — expect PASS** (the `validateTypeChange` test passes by the existing default-deny + `→text` rule).
Run: `cd apps/server && bun test src/routes/fields.test.ts src/lib/field-type-change.test.ts && bun x tsc --noEmit && cd ../../packages/shared && bun test && bun x tsc --noEmit && cd ../../apps/web && bun x tsc --noEmit`
Expected: PASS. Fix any field-type `switch` exhaustiveness errors (field-renderer is handled in Task 2.2).

- [ ] **Step 5: Commit.**
```bash
git add packages/shared/src/index.ts apps/server/src/lib/field-type-change.ts apps/web/src/lib/api/fields.ts
git commit -m "phase-6: add image field type to enum (shared/server/web)"
```

**Test tier:** Tier A — boundary enum + type-change validation (validation-vs-use + a data-migration guard). Test contract: asserts `image` accepted at create, `image→number` denied, `image→text` allowed.

### Task 2.2: Field-renderer `image` case (URL input + img render + scheme guard)

**Files:**
- Modify: `apps/web/src/components/slideover/field-renderer.tsx` (add `case 'image'`)
- Test: `apps/web/src/components/slideover/field-renderer.test.tsx`

- [ ] **Step 1: Write the failing test** — an `image` field with a valid http(s) URL renders an `<img>`; a `javascript:`/`data:` URL is rejected (not committed, or stripped); empty value renders an input affordance.

```tsx
it('image field renders an <img> for http(s) and rejects javascript:', () => {
  const onCommit = vi.fn();
  render(<FieldRenderer fieldKey="cover" type="image" value="https://x/i.png" onCommit={onCommit} />);
  expect(screen.getByRole('img')).toHaveAttribute('src', 'https://x/i.png');
});
it('image field refuses a javascript: URL', () => {
  const onCommit = vi.fn();
  // enter edit, type javascript:alert(1), blur → onCommit NOT called (or called with '')
  // ...drive the input...
  expect(onCommit).not.toHaveBeenCalledWith('javascript:alert(1)');
});
```

- [ ] **Step 2: Run — expect FAIL** (no `image` case → "unsupported type").
Run: `cd apps/web && npx vitest run src/components/slideover/field-renderer.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Add the `image` case** modeled on the existing `UrlField`, with an `<img>` preview + the scheme guard.

```tsx
// in the switch:
case 'image': {
  const url = String(value ?? '');
  return <ImageField value={url} onCommit={onCommit} isPending={isPending} ariaLabel={fieldKey} />;
}
```
```tsx
function isSafeImageUrl(u: string): boolean {
  if (!u) return true; // empty is allowed (clears the field)
  try { const p = new URL(u); return p.protocol === 'http:' || p.protocol === 'https:'; }
  catch { return false; }
}

function ImageField({ value, onCommit, isPending, ariaLabel }: {
  value: string; onCommit: (v: string) => void; isPending?: boolean; ariaLabel: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  if (!editing) {
    return (
      <button type="button" aria-label={ariaLabel} onClick={() => setEditing(true)}
        className={cn('block', isPending && 'opacity-60')}>
        {value && isSafeImageUrl(value)
          ? <img src={value} alt={ariaLabel} loading="lazy" referrerPolicy="no-referrer"
                 className="h-16 w-16 rounded-md object-cover" />
          : <span className="text-fg-3">{value || '(no image)'}</span>}
      </button>
    );
  }
  return (
    <input type="url" aria-label={ariaLabel} value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { setEditing(false);
        if (draft !== value) { if (isSafeImageUrl(draft)) onCommit(draft); else { setDraft(value); /* reject */ } } }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') { setDraft(value); setEditing(false); } }}
      className={cn('block w-full rounded-sm border border-border-light bg-shell px-2 py-1 text-sm text-fg input-focus', isPending && 'opacity-60')} />
  );
}
```

- [ ] **Step 4: Run tests — expect PASS.**
Run: `cd apps/web && npx vitest run src/components/slideover/field-renderer.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add apps/web/src/components/slideover/field-renderer.tsx apps/web/src/components/slideover/field-renderer.test.tsx
git commit -m "phase-6: image field renderer (img preview + http(s) scheme guard)"
```

**Test tier:** Tier A — the scheme guard is the cluster's one security mitigation (the 1a assessment's single ask). Test contract: asserts http(s) renders `<img>`, `javascript:`/`data:` is NOT committed, empty clears.

### Task 2.3: Field-create UI lists `image`; (optional) inference

**Files:**
- Modify: `apps/web/src/components/slideover/frontmatter-form.tsx` (the add-field type list)
- Modify: `packages/shared/src/field-infer.ts` (optional)
- Test: `packages/shared/src/field-infer.test.ts` (only if inference added)

- [ ] **Step 1 (UI):** Add `image` to the field-create type `<select>`/list in `frontmatter-form.tsx` (wherever `FieldType` options are enumerated — grep `frontmatter-form-add-field` for the current list). No logic test (Tier B presentational); a single render assertion that `Image` is an option is enough.

- [ ] **Step 2 (optional inference):** If the team wants auto-`image` for `*.png/.jpg/.webp/.gif/.svg` URLs, add to `field-infer.ts` BEFORE the generic `url` rule, RED-first:

```ts
// in field-infer.ts, after DATETIME/DATE, before the url rule:
if (/^https?:\/\/.+\.(png|jpe?g|webp|gif|svg|avif)(\?|#|$)/i.test(value)) return 'image';
```
```ts
// field-infer.test.ts
it('infers image from an image-extension URL', () => {
  expect(inferFieldType('https://x/p.png')).toBe('image');
  expect(inferFieldType('https://x/page')).toBe('url'); // non-image URL unchanged
});
```
> DECISION: inference is OPTIONAL (the design says "optional"). If it risks mis-inferring (a `.png` query-string API), SKIP it and rely on explicit pin via the `fields` table — note the deferral. Recommend SHIPPING it (cheap, RED-first, the regex is anchored on extension) but it is gated, not blocking.

- [ ] **Step 3: Run tests — expect PASS.**
Run: `cd packages/shared && bun test src/field-infer.test.ts && cd ../../apps/web && npx vitest run src/components/slideover/frontmatter-form-add-field.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit.**
```bash
git add apps/web/src/components/slideover/frontmatter-form.tsx packages/shared/src/field-infer.ts packages/shared/src/field-infer.test.ts
git commit -m "phase-6: field-create lists image; infer image from extension URLs"
```

**Test tier:** UI list = Tier B (`no unit test: Tier B, presentational option list` + one render-presence assertion). Inference (if added) = Tier A (parsing/inference logic) with the contract above.

**Integration gate (Cluster 6):** Run the **## Sibling-site audit** for field-type (grep `case 'currency'` / `case 'url'` in field-renderer + any field-type switch) — confirm no exhaustive switch silently mishandles `image`. Full server + web + shared test + typecheck.

## Acceptance flows — Cluster 3 (image field)

| Flow | Empty/zero-state | Denied actor | Wrong-order/re-entry | Concurrent/double | Boundary value | Mid-flow failure |
|---|---|---|---|---|---|---|
| **Add + render an image field** | No image set → "(no image)" affordance, not a broken `<img>` | (single-team; field CRUD already scope-gated — N/A new boundary) | Edit → blur empty → re-edit → value preserved | Two slideovers edit the same field → last-write-wins (existing updated_at) | A `javascript:`/`data:` URL → rejected, draft reverts | A 404 image URL → browser broken-image icon (acceptable; no app crash) |

`── REVIEW GATE ──` (tier: STANDARD — new field type, client-rendered, no server fetch; the one security ask (scheme guard) is in-cluster and tested. No 1a server surface.) **STOP. 2 finders + simplicity + feature-acceptance pass on the image field. (No security-sentinel — the assessment ruled no server SSRF surface.)**

---

# CLUSTER 4 — Calendar view

> Additive renderer. Reuses FilterBar, DocumentSlideover (`?doc=`), `dueUrgency()`, EmptyState, dnd-kit (the kanban-view PointerSensor distance:5 + DragOverlay pattern). The placement date field comes from the view's `settings.dateField` (default `due_date`).

### Task 3.1: `calendar-grid.ts` — pure month/week date math (Tier A)

**Files:**
- Create: `apps/web/src/components/views/calendar-grid.ts`
- Test: `apps/web/src/components/views/calendar-grid.test.ts`

- [ ] **Step 1: Write failing tests** for the pure functions: `buildMonthGrid(year, month)` → 6×7 cells with leading/trailing days; `placeDocuments(docs, dateField, cells)` → docs bucketed by ISO `YYYY-MM-DD`; unscheduled docs (no/empty date field) returned separately.

```ts
it('buildMonthGrid returns 42 cells spanning the month', () => {
  const cells = buildMonthGrid(2026, 6); // June 2026
  expect(cells).toHaveLength(42);
  expect(cells.some(c => c.iso === '2026-06-01' && c.inMonth)).toBe(true);
});
it('placeDocuments buckets by the chosen date field and separates unscheduled', () => {
  const docs = [{ slug:'a', frontmatter:{ due_date:'2026-06-10' } }, { slug:'b', frontmatter:{} }];
  const { byDay, unscheduled } = placeDocuments(docs, 'due_date');
  expect(byDay['2026-06-10'].map(d=>d.slug)).toEqual(['a']);
  expect(unscheduled.map(d=>d.slug)).toEqual(['b']);
});
```

- [ ] **Step 2: Run — expect FAIL.** Run: `cd apps/web && npx vitest run src/components/views/calendar-grid.test.ts` → FAIL.
- [ ] **Step 3: Implement** `buildMonthGrid`/`buildWeekGrid`/`placeDocuments`. Date parsing keys off the ISO `YYYY-MM-DD` convention (matches `field-infer.ts` `DATE_RE` and the `due_date` convention). Treat a datetime value by slicing the date prefix.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.** `git commit -m "phase-6: calendar-grid pure date math + document placement"`

**Test tier:** Tier A — pure date math + bucketing (logic). Test contract: month boundary (42 cells, leading/trailing), correct bucketing, unscheduled separation, datetime-prefix handling.

### Task 3.2: `calendar-view.tsx` — render grid, slideover, filter, empty/unscheduled

**Files:**
- Create: `apps/web/src/components/views/calendar-view.tsx`, `calendar-skeleton.tsx`
- Test: `apps/web/src/components/views/calendar-view.test.tsx`

- [ ] **Step 1: Write failing tests** — renders the month grid from `useDocuments`; clicking a doc cell navigates `?doc=<slug>` (opens the existing slideover); empty table → EmptyState; documents with no date → an "Unscheduled" tray. Mock `useDocuments`/`useFields`/`useActiveView` like the existing `kanban-view.test.tsx`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `CalendarView({wslug,pslug,tslug})`: read `useActiveView` for `settings.dateField` (default `due_date`), `useDocuments(... type:'work_item', limit:200)`, render `buildMonthGrid` + `placeDocuments`, a month-nav header (prev/next/today), FilterBar reuse, the unscheduled tray, EmptyState when zero docs, the skeleton while loading. A doc chip uses `dueUrgency()` for its accent and navigates `{ to:'.', search:(s)=>({...s, doc:slug}) }`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.** `git commit -m "phase-6: calendar view (month grid + slideover + filter + unscheduled tray)"`

**Test tier:** Tier B for the rendering shell (presentational over the Tier-A grid + tested hooks) — keep render-presence assertions for the grid, EmptyState, and unscheduled tray (spec contract), no logic re-test.

### Task 3.3: Drag-to-reschedule (writes the DATE FIELD to the document)

**Files:**
- Modify: `apps/web/src/components/views/calendar-view.tsx`
- Test: `apps/web/src/components/views/calendar-view-dnd.test.tsx`

- [ ] **Step 1: Write the failing test** (PointerEvent, mirror `kanban-view-dnd.test.tsx`) — dragging a doc chip from day A to day B calls the document PATCH with `frontmatter[dateField] = '<B-iso>'`. Assert the mutation payload, NOT a view write (invariant 16: the date field is a DOCUMENT attribute).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** the DndContext (PointerSensor `distance:5`, DragOverlay) over the calendar cells; `onDragEnd` → `useUpdateDocument(...).mutateAsync({ slug, patch:{ frontmatter:{ [dateField]: targetIso } } })` (optimistic per the existing pattern). The drop target's `iso` is the new date.
- [ ] **Step 4: Run — expect PASS** (≥3× for dnd determinism per the testing-workflow ≥3× rule).
- [ ] **Step 5: Commit.** `git commit -m "phase-6: calendar drag-to-reschedule writes the date field to the document"`

**Test tier:** Tier A — the drag writes a document mutation to the correct entity/field (invariant-16-adjacent: must NOT write the view). Test contract: asserts the document PATCH carries `frontmatter[dateField]=targetIso` and NO view mutation fires.

### Task 3.4: Wire calendar into `viewRendererFor`

**Files:**
- Modify: `apps/web/src/components/views/view-router.tsx`
- Test: `apps/web/src/components/views/view-router.test.tsx` (extend)

- [ ] **Step 1:** Extend the router test — `type:'calendar'` renders the calendar marker (not the "coming soon" fallback).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3:** Replace the `calendar` line in `viewRendererFor` with `(p) => <CalendarView {...p} />`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.** `git commit -m "phase-6: wire CalendarView into ViewRouter"`

**Test tier:** Tier A — the convergence-map wiring (a wrong line renders the wrong view). Test contract: `calendar` type → CalendarView.

**Integration gate (Cluster 3):** Full web suite + typecheck. Browser pass: create a calendar view, see items on their due dates, drag to reschedule (persists on reload), unscheduled tray shows date-less items, FilterBar narrows the grid.

## Acceptance flows — Cluster 4 (calendar)

| Flow | Empty/zero-state | Denied actor | Wrong-order/re-entry | Concurrent/double | Boundary value | Mid-flow failure |
|---|---|---|---|---|---|---|
| **View items on a calendar** | Table with 0 docs → EmptyState | N/A (single-team) | Prev/next month then back → grid recomputes, no stale chips | Two tabs viewing same month → both reflect a reschedule after refetch | Items on month's first/last day land in the right cell (boundary of `buildMonthGrid`) | `useDocuments` errors → error UI, not a blank grid |
| **Unscheduled items** | All docs have a date → tray hidden/empty-labelled | N/A | Set a date on a tray item → it moves to the grid | — | A doc with an invalid date string → stays in the tray (not crashed into a cell) | — |
| **Drag-to-reschedule** | (no items → no drag target) | N/A | Drag then drag back → two PATCHes, final date correct | Double-drop race → last drop wins; optimistic rollback on error | Drag across a month boundary (next-month trailing cell) → writes the trailing cell's real date | PATCH fails → optimistic rollback + toast (existing pattern) |

`── REVIEW GATE ──` (tier: STANDARD — new additive renderer; writes go through the existing tested document PATCH; no 1a surface.) **STOP. 2 finders + simplicity + feature-acceptance browser pass on the three calendar flows.**

---

# CLUSTER 5 — Timeline view

> Additive renderer. Horizontal lanes by day/week/month zoom. Single date field OR a start→end range (two date fields from `settings`: `startField` + `endField`). Reuses FilterBar, slideover, dnd-kit, EmptyState.

### Task 4.1: `timeline-lanes.ts` — pure lane/placement math (Tier A)

**Files:**
- Create: `apps/web/src/components/views/timeline-lanes.ts`
- Test: `apps/web/src/components/views/timeline-lanes.test.ts`

- [ ] **Step 1: Write failing tests** — `buildTimeScale(rangeStart, rangeEnd, zoom)` → ordered columns (day/week/month); `placeOnTimeline(docs, {startField, endField}, scale)` → each doc gets `{ colStart, colSpan }`; a single-date doc spans 1 column; a doc with start>end is clamped/flagged; date-less docs are excluded (returned as `unplaced`).

```ts
it('single-date doc spans one column; range doc spans start..end', () => {
  const scale = buildTimeScale('2026-06-01', '2026-06-30', 'day');
  const { placed } = placeOnTimeline(
    [{ slug:'a', frontmatter:{ due_date:'2026-06-10' } },
     { slug:'b', frontmatter:{ start_date:'2026-06-05', end_date:'2026-06-08' } }],
    { startField:'start_date', endField:'end_date', fallbackField:'due_date' }, scale);
  expect(placed.find(p=>p.slug==='a')?.colSpan).toBe(1);
  expect(placed.find(p=>p.slug==='b')?.colSpan).toBe(4);
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** the scale builder + placement. Zoom maps a date to a column index; range = `[startField, endField]`, falling back to a single `fallbackField` (default `due_date`) when no range configured.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.** `git commit -m "phase-6: timeline-lanes pure scale + range placement math"`

**Test tier:** Tier A — pure placement/range math. Test contract: single-date span=1, range span correct, start>end clamped, date-less excluded, each zoom level's column mapping.

### Task 4.2: `timeline-view.tsx` — render lanes, zoom, slideover, filter, empty

**Files:**
- Create: `apps/web/src/components/views/timeline-view.tsx`, `timeline-skeleton.tsx`
- Test: `apps/web/src/components/views/timeline-view.test.tsx`

- [ ] **Step 1: Write failing tests** — renders the time scale + placed bars; a zoom control (day/week/month) re-renders columns; clicking a bar → `?doc=<slug>`; empty table → EmptyState. Mock hooks like kanban-view.test.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `TimelineView`: `useActiveView` → `settings.{startField,endField,zoom}` (zoom default `week`, fallback `due_date`), `useDocuments`, `buildTimeScale` + `placeOnTimeline`, a zoom toggle (persists to `settings.zoom` via `useUpdateView` — invariant 16: view-owned config), FilterBar, EmptyState, skeleton. Bars use `dueUrgency()` accent. "This Week" affordance = a "today" marker line + a jump-to-today button (cheap; include it).
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.** `git commit -m "phase-6: timeline view (lanes + zoom + slideover + filter)"`

**Test tier:** Tier B rendering shell over the Tier-A math + tested hooks; keep render-presence assertions for the scale, bars, zoom control, EmptyState. The zoom→`useUpdateView` persistence is a behavior worth ONE assertion (Tier A slice): zoom change writes `settings.zoom` to the VIEW, not the document.

### Task 4.3: Drag-to-reschedule on the timeline + wire into router

**Files:**
- Modify: `apps/web/src/components/views/timeline-view.tsx`
- Modify: `apps/web/src/components/views/view-router.tsx`
- Test: `apps/web/src/components/views/timeline-view-dnd.test.tsx`, `view-router.test.tsx`

- [ ] **Step 1: Write failing tests** — dragging a bar horizontally writes the new `startField` (and shifts `endField` by the same delta for a range) to the DOCUMENT (not the view); router test: `type:'timeline'` → TimelineView.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** the DndContext drag (PointerSensor distance:5); `onDragEnd` computes the column delta → new dates → `useUpdateDocument` PATCH with the shifted `frontmatter` dates (preserve the range duration). Replace the `timeline` line in `viewRendererFor` with `<TimelineView {...p} />`.
- [ ] **Step 4: Run — expect PASS** (≥3× for dnd).
- [ ] **Step 5: Commit.** `git commit -m "phase-6: timeline drag-reschedule (range-preserving) + wire into ViewRouter"`

**Test tier:** Tier A — drag writes the correct document dates preserving range duration (invariant-16-adjacent). Test contract: single-date drag writes `startField`; range drag shifts BOTH fields by the delta; writes the document, not the view.

**Integration gate (Cluster 4):** Full web suite + typecheck. Browser: create a timeline, see range bars, switch zoom (persists), drag a bar (range duration preserved on reload), FilterBar narrows.

## Acceptance flows — Cluster 5 (timeline)

| Flow | Empty/zero-state | Denied actor | Wrong-order/re-entry | Concurrent/double | Boundary value | Mid-flow failure |
|---|---|---|---|---|---|---|
| **View items on a timeline** | 0 docs → EmptyState | N/A | Zoom day→month→day → bars recompute correctly | Two tabs → both reflect a reschedule after refetch | Item at scale edge (rangeStart/rangeEnd) → bar clamps to visible scale, not overflow | `useDocuments` error → error UI |
| **Range items (start→end)** | No range fields configured → falls back to single `due_date` bars | N/A | Reconfigure start/end fields in settings → bars re-place | — | start==end → span 1; start>end → clamped + flagged, no negative span | A doc missing the endField → renders as a single-date bar |
| **Zoom day/week/month** | — | N/A | Rapid zoom toggling → last zoom persists to `settings.zoom` | Double zoom-click → idempotent | — | `useUpdateView` fails → toast; UI shows the attempted zoom optimistically then rolls back |
| **Drag-to-reschedule** | — | N/A | Drag then back → final dates correct | Double-drop → last wins; rollback on error | Drag a range bar past scale edge → clamps; duration preserved | PATCH fails → rollback + toast |

`── REVIEW GATE ──` (tier: STANDARD — additive renderer; document writes via the tested PATCH, view config via tested useUpdateView; no 1a surface.) **STOP. 2 finders + simplicity + feature-acceptance browser pass on the four timeline flows.**

---

# CLUSTER 6 — Gallery view + G3

> Additive renderer: responsive card grid, cover from the chosen `image` field (`settings.coverField`), fallback for no-image, click → slideover, FilterBar reuse, EmptyState. Folds in G3 (the shared view-layout horizontal-overflow/scroll affordance the table + new views inherit).

### Task 5.1: `gallery-view.tsx` — card grid + cover + fallback + filter + empty

**Files:**
- Create: `apps/web/src/components/views/gallery-view.tsx`, `gallery-skeleton.tsx`
- Test: `apps/web/src/components/views/gallery-view.test.tsx`

- [ ] **Step 1: Write failing tests** — renders one card per doc; a doc whose `settings.coverField` value is a safe http(s) URL renders an `<img>` cover; a doc with no image renders a placeholder card (title only); clicking a card → `?doc=<slug>`; empty table → EmptyState; if no `coverField` configured, all cards are placeholder (no crash).

```tsx
it('renders an image cover when coverField is set and safe, placeholder otherwise', () => {
  // mock useActiveView → settings:{coverField:'cover'}; useDocuments → [{cover:'https://x/i.png'},{}]
  render(<GalleryView wslug="w" pslug="p" tslug="t" />);
  expect(screen.getAllByRole('img')).toHaveLength(1);
  expect(screen.getByText(/no image|placeholder/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `GalleryView`: `useActiveView` → `settings.coverField`, `useDocuments`, a responsive `grid` (Tailwind `grid-cols-2 sm:grid-cols-3 lg:grid-cols-4`), each card = cover `<img loading="lazy" referrerPolicy="no-referrer">` (reuse `isSafeImageUrl` from Task 2.2 — EXPORT it from field-renderer or lift it to a shared `lib/image-url.ts` to avoid duplication) + title, FilterBar, EmptyState, skeleton. Card click navigates `?doc=`. Use `loading="lazy"` for many-cards perf.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.** `git commit -m "phase-6: gallery view (card grid, safe cover, placeholder fallback, lazy)"`

**Test tier:** Tier B rendering shell over tested hooks — keep render-presence assertions for cover-vs-placeholder, EmptyState (spec contract). The `isSafeImageUrl` reuse means no new security logic to test here (it's tested in 2.2); if lifted to `lib/image-url.ts`, move its test there too.

### Task 5.2: Wire gallery into router

**Files:**
- Modify: `apps/web/src/components/views/view-router.tsx`
- Test: `apps/web/src/components/views/view-router.test.tsx` (extend)

- [ ] **Step 1:** Router test — `type:'gallery'` → GalleryView.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3:** Replace the `gallery` line in `viewRendererFor` with `<GalleryView {...p} />`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.** `git commit -m "phase-6: wire GalleryView into ViewRouter"`

**Test tier:** Tier A — convergence-map wiring. Contract: `gallery` → GalleryView.

### Task 5.3: G3 — shared view-layout horizontal-scroll affordance

**Files:**
- Modify: `apps/web/src/components/shell/main-frame.tsx` (the content frame that wraps `<Outlet/>` / `<ViewRouter>`)
- Modify: `apps/web/src/components/table/table-view.tsx` (apply the overflow container if the clip originates there)
- Test: `apps/web/src/components/table/table-view.test.tsx` (assert the scroll container class is present)

- [ ] **Step 1: Reproduce** the G3 bug FIRST (do NOT reason from source — see lessons.md "Measure DOM for layout bugs"): run the dev server, open a table with many columns, measure via `superpowers-chrome` `use_browser` whether the column row clips with no horizontal scrollbar (`scrollWidth > clientWidth` but `overflow-x` not `auto`).
- [ ] **Step 2: Write a failing/guard test** asserting the view content container carries `overflow-x-auto` (or the chosen affordance) so columns can scroll.
- [ ] **Step 3: Fix** the container: wrap the view content in an `overflow-x-auto` region with a sticky-left first column if appropriate, and a subtle right-edge fade to signal more columns. Keep it on the SHARED frame so all views (table + the 3 new) inherit it.
- [ ] **Step 4: Run — expect PASS;** re-measure in the browser: columns now scroll, affordance visible.
- [ ] **Step 5: Commit.** `git commit -m "phase-6: G3 — horizontal scroll affordance for the shared view layout"`

**Test tier:** Tier B — CSS/layout fix; the proof is the browser measurement (feature-acceptance), not a unit test. Keep one guard assertion that the overflow class is present so a future refactor doesn't silently drop it. `no unit test beyond the class-presence guard: Tier B, layout fix verified in-browser`.

**Integration gate (Cluster 5):** Full web suite + all three typechecks + `bun run check:invariants`. Browser: create a gallery view, covers render for image-field docs, placeholders for the rest, click → slideover, FilterBar narrows; verify G3 column scrolling on a wide table.

## Acceptance flows — Cluster 6 (gallery + G3)

| Flow | Empty/zero-state | Denied actor | Wrong-order/re-entry | Concurrent/double | Boundary value | Mid-flow failure |
|---|---|---|---|---|---|---|
| **Browse a gallery** | 0 docs → EmptyState | N/A | Change `coverField` in settings → covers re-resolve | Two tabs → both reflect new docs after refetch | Many cards (200) → lazy-load, no jank (perf boundary) | `useDocuments` error → error UI |
| **No-image fallback** | All docs lack the cover field → all placeholder cards, not blank | N/A | Set an image on a placeholder card's field → cover appears on refetch | — | A doc whose cover value is a non-image/javascript URL → placeholder (isSafeImageUrl guard), not broken `<img>` | A 404 cover URL → broken-image icon on that card only |
| **G3 wide-table scroll** | Few columns → no scrollbar, no fake affordance | N/A | Resize narrower → affordance appears; wider → disappears | — | Exactly-fits width → no scrollbar (boundary) | — |

`── REVIEW GATE ──` (tier: STANDARD — additive renderer reusing the tested safe-URL guard; G3 is a CSS layout fix verified in-browser; no 1a surface.) **STOP. 2 finders + simplicity + feature-acceptance browser pass on the gallery + G3 flows.**

---

## Spec-close (after Cluster 5)

Run `/shakeout` on the full `phase-6/views` branch diff (STANDARD tier → 2 reviewers + the feature-acceptance browser pass driving ALL the acceptance matrices above + the test-effectiveness audit). Then `superpowers:finishing-a-development-branch`. Confirm before merge: every legacy URL redirects (no 404), all 5 view types render via the single `viewRendererFor`, the image field's scheme guard holds, `bun run check:invariants` green, G3 + G4 verified in-browser.

---

## Self-review (writing-plans checklist)

**1. Spec coverage:**
- renderAs refactor (view.type source of truth, `<ViewRouter>`, unified route, back-compat redirects, new-view picks type, NocoDB switching, list+kanban unchanged) → Cluster 1 (Tasks 1.0–1.7). ✓
- `image` field type (enum, server validation, renderer, inference, create UI) → Cluster 2. ✓
- Calendar (chosen date field, drag-reschedule, unscheduled, empty) → Cluster 3. ✓
- Timeline (single/range, zoom, drag-reschedule, empty) → Cluster 4. ✓
- Gallery (cover field, fallback, click→slideover, filter, empty) → Cluster 5. ✓
- G3 (column overflow) → Task 5.3. G4 (operator-panel toggle) → Task 1.6. ✓ G1/G2 DEFERRED (out of scope) — stated. ✓
- 5 clusters, each a gated `── REVIEW GATE ──`. ✓

**2. Placeholder scan:** No "TBD"/"add validation"/"similar to Task N" — each code step shows code; the one OPTIONAL item (inference, Task 2.3) is marked optional with a decision + the actual regex. ✓

**3. Type consistency:** view-type spelled `'calendar' | 'timeline' | 'gallery'` and field-type `'image'` identically across the "Enum consistency" section and every task. `viewRendererFor`, `useActiveView`, `isSafeImageUrl`, `views.settings`, `settings.dateField`/`coverField`/`startField`/`endField`/`zoom` named consistently. The renderer map is `viewRendererFor` in Task 1.2 and every wiring task (3.4/4.3/5.2). ✓

**4. Ground-truth confirmed against HEAD (31af22a1):** view-type enum is 4 sites (shared/server-Zod/web/schema, NO SQL CHECK — confirmed in 0000/0003); field-type enum is 3 sites (shared union / server `FIELD_TYPES` const / web union — server uses `FIELD_TYPES` NOT the shared union); `views` has NO settings column (Task 1.0 adds it); `validatePublicUrl` is server-outbound-only (image field never server-fetched); G4 panel has no toolbar toggle (only dropdown + Cmd-K); `resolveViewNav` currently special-cases default+kanban (Task 1.5 simplifies). ✓
