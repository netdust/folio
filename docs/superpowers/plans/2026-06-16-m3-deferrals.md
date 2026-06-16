# M3 Deferrals Mop-up — Plan

> Class A. Branch `chore/m3-deferrals` off main `a5a0e1f6`. Closes the three tracked M3 follow-ups. Subagent/inline execution, serial commits, finish-branch to Stefan's gate.

**Goal:** Close the labels server-side filter (backlog #9), write the deferred new-view-create e2e spec, and add the optional inv-4a prose note — finishing the audit's loose ends.

---

## Threat model (gate 1a — fires on #1: untrusted filter input → `json_each` SQL)

**Asset:** the document-list SQL query; the `documents.frontmatter` JSON column. **Actor:** any authenticated caller who can hit `GET /documents?filter=` (already scoped by pScope/access — this operator does not change *which rows* are visible, only the predicate).

| Attack | Mitigation (named, must hold in the diff) |
|---|---|
| **SQL injection via the label value** (`' OR '1'='1`) | The value flows through Drizzle's `sql` template as a BOUND PARAM (`${value}`), never string-interpolated — mirror `backlinks.ts:33-38`'s exact parameterized pattern. RED-test a value containing a quote/`OR` proves it's treated as data. |
| **Unknown-operator bypass** (a crafted op string skips validation) | `$contains` added to BOTH the `Operator` union AND the `OPERATORS` whitelist Set (`filter-compile.ts`). The existing `throw` at the whitelist remains the single gate; no new operator path bypasses `filterCompile()`. |
| **Type-confusion via the value** (`$contains: {evil:1}` or a non-string) | `filterCompile` validates the `$contains` value is a string OR string[] of strings; reject otherwise with `FilterCompileError` → 422. Don't let an object/number reach `json_each`. |
| **DoS via huge value array** (`$contains: [...10k strings]`) | Cap the `$contains` array length in `filterCompile` (reuse/match any existing `$in` cap; if none, a sane bound e.g. 100) → 422 over the cap. Each value = one EXISTS subquery AND-ed; unbounded = unbounded subqueries. |
| **Full-scan DoS** (`json_each` over every row) | Accept for v1 — same scan profile as the existing `json_extract` frontmatter filters (priority already does this); no new index promised. Documented, not mitigated. (Deferral.) |

**Deferral:** full-table-scan cost of frontmatter filtering is pre-existing (priority `$eq` has it too); not addressed here. Indexing frontmatter keys is a separate perf task.

---

## Task 1 — `$contains` operator + labels server-side (Tier A, RED-first)

**Files:** `packages/shared/src/filter-compile.ts` (+ `.test.ts`), `apps/server/src/lib/filter-to-drizzle.ts` (+ `.test.ts`), `apps/web/src/lib/api/documents.ts` (+ `.test.ts`).

- [ ] **Shared:** add `'$contains'` to `Operator` union (line 1) AND `OPERATORS` Set (18-28). In `filterCompile`'s per-op handling, validate the `$contains` value is `string | string[]` of strings, length-capped (≤100); else `FilterCompileError`. AST carries `op:'$contains', value: string|string[]`.
- [ ] **Shared test (RED-first):** AST-shape test for `$contains`; denial tests — non-string value → throws, over-cap array → throws, unknown op still throws.
- [ ] **Server compiler:** add `case '$contains':` in `cmpToSql`. For a frontmatter key, emit `EXISTS (SELECT 1 FROM json_each(json_extract(${documents.frontmatter}, ${'$.'+key})) WHERE value = ${v})` per value, AND-ed across an array (matches the AND-of-contains client semantics). BOUND param for every `v` (mirror backlinks.ts). For a built-in column, `$contains` is meaningless → throw (columns aren't arrays).
- [ ] **Server test (RED-first, real DB):** seed docs with `labels: ['bug','urgent']` etc.; `$contains: 'bug'` returns the right rows; `$contains: ['bug','urgent']` AND-semantics (only docs with BOTH); **injection test** — `$contains: "x' OR '1'='1"` returns zero rows (treated as a literal label, not SQL); a doc without the label excluded.
- [ ] **Client:** in `clausesToFilterJson`, add `if (c.kind === 'labels') filter.labels = { $contains: c.values }`. REMOVE the `labels` branch from `applyFrontmatterClauses` (now server-side). Update the doc-comment that says labels is excluded.
- [ ] **Client test:** the existing `documents.test.ts:27` assertion ("does NOT put labels in the server filter") INVERTS — labels now ARE in the filter as `{$contains: [...]}`. This is a deliberate contract change; update it + add the page-2 labels-match case (sibling of the priority one).
- [ ] tsc clean (shared, server, web); full suites green; commit `phase-m3-deferrals: $contains operator + labels server-side filter (backlog #9)`.

## Task 2 — new-view-create Playwright e2e spec (mechanical)

**Files:** `apps/web/tests/e2e/click-through.spec.ts` (or a new spec).
- [ ] Add a spec: open a project rail, click the table's "new view" affordance, fill the name, Create → assert the new view appears in the rail (closes the `unverified-no-browser` edge from the M3 browser drive — the rail-render + endpoint halves were already proven; this drives the click trigger). Match the existing click-through structure (raw locators, the fixtures harness).
- [ ] Run the spec in isolation (it's e2e — boots its own stack). Commit `phase-m3-deferrals: e2e spec for in-app new-view create (M3 unverified edge)`.

## Task 3 — inv-4a prose note (mechanical, ~10 min)

**Files:** `ARCHITECTURE-INVARIANTS.md`.
- [ ] Add one line under invariant 4a: requested child slugs (e.g. a batched `?tables=`) are intersected with the resolved project's own children, so a batched read can't out-scope its project. Run `bun run check:invariants` (0/0). Commit `phase-m3-deferrals: note child-slug intersection under inv-4a`.

---

## Review (Stage 3)
- STANDARD + **`security-sentinel`** on Task 1 (the `$contains` operator is a parsing→SQL surface — verify the bound-param + whitelist + value-validation mitigations hold in the code). `/security-review` fires (a threat model exists).
- /integration full branch; finish-branch — **DO NOT MERGE (Stefan gates).**

## Acceptance (Task 1 is user-facing)
Labels filter now works across pages: a doc whose label-match lands on page 2 IS found (sibling of the priority page-2 fix). Browser drive optional (jsdom test + the server real-DB test cover the logic; the priority flow already proved the pagination UI).
