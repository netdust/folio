# Codebase health audit — tracked debt (2026-06-01)

Whole-codebase architectural health audit on `main` (after the relation-fields + agents-page merges + this session's churn). Three parallel audits: architecture, cleanliness/dead-code, performance. **Overall verdict: Healthy-with-debt.** The churn did not rot the codebase; locked decisions hold; claude-code left no scar.

This file tracks the findings that were **logged, not fixed** this session. The security + cheap-win findings were already fixed (see "Fixed this session" at the bottom).

---

## Debt — worth doing, in a deliberate cleanup pass (not urgent)

### D1 — `lib → routes` import inversion (architecture; the C1 root cause)
`apps/server/src/lib/agent-tools-registry.ts` imports `createRunForParent` + `loadRunScopedByToken` from `routes/runs.ts`. A `lib` module depending on a `route` module inverts the layering, and it's *why* the system_prompt leak (C1) happened — the shared run-load logic lives in a route file, so route-level redaction didn't travel with it to the MCP consumer.
- **Fix direction:** move the context-free run ops (`loadRunScopedByToken`, `createRunForParent`) into `services/agent-runs.ts`; the route keeps only the Hono-bound `loadRunScoped(c, …)` wrapper. Do this the next time runs code is touched.
- **Severity: Important.** (The leak itself is already fixed defensively at the loader; this is the structural cleanup that prevents the next instance.)

### D2 — `services/agent-runs.ts` (1716 LOC) is a cohesion grab-bag
Owns run CRUD + slug-gen + state-machine (`transitionRun`) + token accounting + provider-health (~250 LOC) + runs-table view seeding (~200 LOC) + rate-limit/chain guards + chain-id gen. Provider-health and runs-table-seeding have no natural relationship to run-lifecycle.
- **Fix direction:** extract `provider-health.ts` and `runs-table-seed.ts` as siblings; the run-lifecycle core (create/transition/claim/recover) is the cohesive remainder.
- **Severity: Important** (merge-conflict magnet; unrelated-concern coupling). Not urgent.

### D3 — triplicated `agent.task.assigned` emission + assignee-diff
Implemented in `services/documents.ts::createDocument` (~:667), `::updateDocument` (~:958), AND the raw-markdown PATCH branch in `routes/documents.ts` (~:370) which bypasses `updateDocument` and re-implements the diff+emit inline.
- **Fix direction:** the markdown PATCH should converge on `updateDocument` instead of re-implementing it. Assignment is load-bearing (it triggers the runner), so three copies = drift risk.
- **Severity: Important.**

### D4 — consolidation cluster (cleanliness; several small, low-risk)
- **5 near-identical slug-uniqueness helpers** in `lib/slug-unique.ts` (`slugUniqueInDocuments/…WorkspaceDocuments/…Projects/…Workspaces/…Tables`) — already share `pickFree()`; collapse to one `slugUnique(tx, base, queryFn)`. ~45 LOC saved.
- **`PROVIDER_LABELS[…] ?? 'Claude Code'` repeated 3×** in `runner.ts` (:160, :215, :599) — extract a `providerLabel()` helper; the `'Claude Code'` fallback is arguably the wrong default (use `'AI'`).
- **Provider lists duplicated** server (`runner.ts PROVIDER_LABELS`) vs web (`provider-model-field.tsx PROVIDERS`) — single registry in `packages/shared` (id, label, models, freeText, keyless).
- **3 hand-maintained `FieldType` unions** (`lib/field-type-change.ts` = validation SoT, web `lib/api/fields.ts`, shared `index.ts`) — no compile-time link; shared drifted stale once already. Make shared the single source; server + web import it. (DB CHECK constraint stays separate — inherent to SQLite.)
- **4 orphaned shared exports** (verified 0 importers): `DocumentCreateInput`, `DocumentPatchInput` (`document-schema.ts`), `ViewType` (also stale — product now has list/board/wiki) + `InferContext` re-export (`index.ts`). Drop them.
- **Severity: Minor each** — bundle into one "consolidation" cleanup commit.

### D5 — `agent_run` walling-off duplicated in 5+ spots
The "agent_run is runner-owned, not a generic document" rule is re-asserted in `listDocuments`, `createDocument`, generic-listing exclusion, and 3 MCP tools. Intentional defense-in-depth (each guard blocks a real attack), but 5 edit sites for one rule.
- **Fix direction:** a single predicate helper both layers call. Low priority.
- **Severity: Minor.**

---

## Scaling cliffs — fine at per-customer scale, note for a busy instance

### S1 — query-time backlinks: full `json_each` partition scan, no index (structural ceiling)
`services/backlinks.ts::findBacklinks` scans every work_item/page in the workspace + per-row `json_each` over frontmatter. SQLite can't index arbitrary JSON values, so no index helps the current shape. Sub-ms at hundreds of docs; a visible scan on every slideover open at 10k+ docs. **This is the relation feature's structural ceiling.**
- **Fix direction (only when it bites):** derive a `document_links(source_id, target_slug)` side table populated in the same `txWithEvents` as document writes (parse `[[slug]]` out of frontmatter), indexed on `target_slug`. Pure cache, rebuildable from frontmatter → doesn't violate markdown-as-truth. **Do NOT pre-build** — document the ceiling, build when doc count or slideover latency warrants.
- **Severity: Medium, deferred.**

### S2 — custom-field sort/filter + assignee filter do per-row `json_extract`, no expression index
`documents.ts` assignee filter + custom-field sort use `json_extract` with no supporting index (only `chain_id` has one). Bounded by ONE project's doc count + narrowed by `documents_project_type_idx`. Fine at hundreds of items.
- **Fix direction:** add partial expression indexes for the 1–2 hottest sort keys (priority, due_date) when a customer has a large table — not generically, not yet.
- **Severity: Low–Medium, deferred.**

---

## Dormant (deliberate — keep, don't delete)

### Parked manual board-sort chain (~250 LOC)
`reorderEnabled` hardcoded `false` (`kanban-view.tsx:132`), "Manual" sort menu item commented out (`board-toolbar.tsx`). Renders an unreachable chain: `board-reorder.ts` (`computeReorderPosition`), `packages/shared/src/board-rank.ts` (`rankBetween`, stress-tested), the `resolveDrop` reorder/regroup-reorder arms, the server `board_position` keyset-sort branch + column.
- **Decision (Stefan, this session): KEEP PARKED.** Manual sort was deliberately parked with intent to revisit ("park this for now"), not abandoned. Code is dormant + harmless + git-recoverable. Do NOT delete; un-park when the feature is scheduled (search "PARKED" comments). It reads as live, though — a reader must trace `reorderEnabled` to discover it's no-ops.
- **Severity: N/A (intentional).** Listed so it's not "rediscovered" as a bug.

### claude-code provider
Functional but deprioritized + slow (~8s local-CLI floor, real tool runs 24–60s). Audits confirmed it's cleanly isolated (gated by `FOLIO_CLAUDE_CODE_ENABLED`, separate `cc-executor.ts`, sound `REGISTRY`-absent pattern). The injection-fence (`runner.ts` ccExecute) is a bounded mitigation, NOT a full prompt-injection solve. The resume path threads no `buildResumeMessages` context into cc (documented v1 limitation). Leave as-is; delete eventually if it stays unused.

---

## Decision-doc gap

### `board_position` is a 4th `documents` column vs "frontmatter is the schema"
`schema.ts:234` + migration 0018 added `board_position text` as a dedicated column. Decision #2 says only title/status/body are columns. Defensible for fractional-rank query perf, but added without a `DECISIONS.md` entry → undocumented exception that sets an un-adjudicated precedent.
- **Action:** either record it as a deliberate, reasoned exception in `memory/DECISIONS.md`, or move it to frontmatter / a view-scoped store. (Tied to the dormant board-sort — revisit together if/when manual sort un-parks.)

---

## Fixed this session (for the record)
- **C1 (security):** `system_prompt` leaked via the run-read surfaces. Redacted at the shared loader `loadRunScopedByToken` (covers HTTP + MCP `get_run`/`retry_run`/`cancel_run`) — `f3e9575`; then the MCP `list_runs` list path (third path) — `f016315`. Guard tests at both. All run-read surfaces now redact.
- **C2 (perf):** `listRuns` capped with a SQL `LIMIT` (workspace path) instead of fetch-all-then-slice-in-JS — `f3e9575`.
- **O5 (perf):** TableView relation-resolver `useDocuments` queries gated behind has-relation-column — `2022bc6`.

Gates after fixes: server 1055/0, shared 63/0, web 705/8-skip/0, tsc clean ×3.
