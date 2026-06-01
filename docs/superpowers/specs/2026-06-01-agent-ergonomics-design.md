# Agent Ergonomics — Design

**Date:** 2026-06-01
**Status:** Approved (brainstorm complete; pending writing-plans)
**Branch target:** new branch off `main` (current HEAD `b88794e`)

## Thesis

The agent is the **expert user** of Folio and the **canary** for human usability: every friction an
agent hits, a human hits worse. The agent at least has patience and can brute-force; a human gives up
or fabricates. So agent-surface friction is a P0 defect class, not a polish item.

Two frictions were observed live during an MCP smoke test (setting "Hosting setup on Combell" to
`done`):

1. **No title→document lookup.** The API speaks `slug` + `project_slug`. Given only a title, the agent
   must guess the project, `list_documents` with a high limit, and eyeball the result. Found it on luck,
   not information. Breaks down past a few dozen documents.
2. **List noise.** `list_documents` returned ~40% `comment` rows interleaved with real work items —
   pure context burn that the agent must filter mentally.
3. **API learned by trial.** Valid status keys (`done`) and patch-merge semantics were discovered
   mid-task by probing, not known on arrival.

This design fixes all three, plus adds a minimal one-call orientation primitive.

## Scope decisions (locked during brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| `find` match target | Title substring, case-insensitive, workspace-wide | Solves ~90% of "the X one" lookups. FTS5 is explicitly deferred to v1.1 per CLAUDE.md. Implemented via a new `titleQuery` option on `listDocuments` (a `LIKE` clause), NOT the filter engine — confirmed the filter AST has no substring operator (`$eq/$ne/$in/$nin/$gt/$gte/$lt/$lte/$exists` only). |
| List de-noise | Exclude system types by default | Cleanest signal; gated on a backward-compat caller audit. |
| Operating-surface docs | Tighten tool descriptions only | Cheap, high-leverage. Skill-as-content doc stays a named follow-up. |
| Surface | Shared registry (MCP + in-app runner + REST) | One source; the canary and in-app agents inherit identically. |
| `describe_workspace` | Folded in, **deliberately minimal** | Useful one-call orientation. Minimal shape keeps the contract small + growable. |

## Out of scope (named follow-ups — do not scope-creep)

- FTS5 / ranked full-text search (deferred to v1.1 by CLAUDE.md).
- Fuzzy / typo-tolerant title matching.
- Body / frontmatter-value search.
- `describe_workspace` growth: fields, views, per-field types, document counts, `depth`/summary param.
- Skill-as-content "how to operate this workspace" doc.

---

## The build — four items

All four land in `apps/server/src/lib/agent-tools-registry.ts` (the shared registry consumed by the MCP
route and the in-process runner) and/or `apps/server/src/services/documents.ts`. New tools follow the
existing resolve-workspace → resolve-project → service-call → `textResult` pattern. Allow-list
enforcement reuses `resolveAgentProjects` + `intersectAgentProjects` (registry lines ~376–381) exactly
as `list_projects` does today.

### Item 1 — `find_documents` (new shared-registry tool)

```
find_documents({
  workspace_slug,          // required
  query,                   // required — case-insensitive title substring
  project_slug?,           // optional — narrow to one project
  type?,                   // optional — work_item | page (defaults to authorable types)
  limit?                   // optional — default 25
})
→ { documents: [{ id, slug, title, type, status, project_slug, updated_at }], next_cursor? }
```

- **`project_slug` in EACH result row** is a correctness requirement, not a nicety: workspace-wide find
  returns hits across projects, and every mutation tool requires `project_slug`. Omitting it returns
  slugs the agent cannot act on.
- **Title match via a new `titleQuery` option on `listDocuments`.** The existing `filter` engine
  (`filterCompile` / `compileFilterToWhere`) supports only equality/range operators
  (`$eq/$ne/$in/$nin/$gt/$gte/$lt/$lte/$exists`) — NO substring/`LIKE`. So `find` adds a small explicit
  `titleQuery?: string` to `ListDocumentsOptions` that pushes a case-insensitive `LIKE` clause on
  `documents.title`, mirroring the existing `assignee` `sql\`...\`` clause (services/documents.ts:251).
  Tiny, well-understood addition — not a reverse-engineered DSL extension.
- **Scope enforcement (SECURITY-CRITICAL):**
  - `project_slug` given → resolve via `resolveProjectInWorkspace` (inherits the allow-list check),
    then single-project title filter.
  - `project_slug` absent (workspace-wide) → enumerate the projects the token may see
    (`resolveAgentProjects` + `intersectAgentProjects`, same as `list_projects`), query only those.
    **An agent MUST NOT find a document in a project it is not allow-listed for.**
- `requiredScope: 'documents:read'`.

### Item 2 — `describe_workspace` (new shared-registry tool, minimal v1)

```
describe_workspace({ workspace_slug })   // no depth param, no options in v1
→ {
    workspace: { slug, name },
    projects: [
      {
        slug, name,
        tables: [
          { slug, statuses: [{ key, name, category }] }
        ]
      }
    ]
  }
```

- **Status KEYS are the payload that matters** — the one thing an agent must know to act (exactly what
  had to be fetched separately for the Combell update). Pure composition over existing service
  functions: `list_projects` logic + `tables.findMany` per project + `listStatuses(tableId)`. No new
  queries, no migration.
- **Excluded from v1 (the growable edge):** fields, views, per-field types, document counts,
  `depth`/summary param. These are what blow up response size and lock a bigger contract; they wait for
  the deliberate `describe_workspace` brainstorm (which becomes a *grow*, not a *build*).
- **Scope enforcement:** same allow-list path as `find_documents`. A non-allow-listed project must not
  appear at all — not even its name/structure.
- `requiredScope: 'documents:read'`.

### Item 3 — `list_documents` de-noise (services/documents.ts)

One-line sibling to the existing `agent_run` exclusion (~line 232). Today, when no `type` is supplied,
the WHERE clause excludes `agent_run` but **not `comment`** — the observed leak.

```ts
// existing:
whereClauses.push(ne(documents.type, 'agent_run'));
// added — comments are reply-thread rows, not authorable documents:
whereClauses.push(ne(documents.type, 'comment'));
```

- **After:** `list_documents` with no `type` returns `work_item` + `page` only. Comments → `list_comments`;
  runs → `list_runs` (both already exist and are the correct surface).
- **BACKWARD-COMPAT GATE (first task in the plan):** grep every caller of `listDocuments` — server routes,
  the web client's document-list hooks, tests — and confirm none relies on `comment` rows appearing in
  the generic list. If one does, that is a finding to resolve in the plan, not a silent break.
- **Blast radius note:** this is a *shared service* change, so it affects the REST `/documents` route and
  the web UI list, not just MCP. That is correct and desired (the UI list should not show comment rows
  either), but it widens the test surface to include web.

### Item 4 — description tightening (agent-tools-registry.ts)

Authored once in the registry; MCP + in-app runner + REST inherit identically.

- **`find_documents`** (new): "Resolve a title to a document. Case-insensitive substring match on title,
  workspace-wide by default (narrow with project_slug). Use this when you have a title but not a slug —
  do NOT page through list_documents." (Last clause is the behavioral nudge away from brute-forcing.)
- **`list_documents`**: append "Returns work_item + page only. Comments → list_comments; runs →
  list_runs." (So the agent understands the new default.)
- **`update_document`**: add "Discover valid status keys via list_statuses." (The exact thing inferred
  by probing during the Combell update.)
- **`describe_workspace`** (new): "One-call orientation: every allow-listed project, its tables, and each
  table's status keys. Call this first to learn the workspace shape."

---

## Testing (TDD — tests before implementation, per harness)

### `find_documents`
- Title match: hit / miss / case-insensitive.
- Workspace-wide returns multi-project results, each carrying the correct `project_slug`.
- **Allow-list enforcement (MANDATORY security test):** an agent-bound token does NOT find documents in
  a non-allow-listed project, both workspace-wide and via an explicit non-allow-listed `project_slug`.
- Project-scoped narrowing works.
- `limit` respected; `next_cursor` shape if paginated.

### `describe_workspace`
- Returns workspace + projects + tables + status keys for an allow-listed set.
- **Allow-list enforcement:** non-allow-listed projects are absent entirely (name included).
- Status key/name/category shape matches `listStatuses`.

### `list_documents` de-noise
- No `type` → excludes `comment` AND `agent_run`; returns only work_item + page.
- Explicit `type=work_item` / `type=page` unchanged.
- Backward-compat caller audit (the gate above) recorded as a plan task with its findings.

### descriptions
- Assert the new description strings surface in `tools/list` (cheap regression guard).

## Verification

- `cd apps/server && bun test` (server unit) — green, with the new tests.
- `cd packages/shared && bun test` if shared types touched.
- `cd apps/web && npx vitest run` — green (de-noise touches the shared service the web list consumes).
- `bun x tsc --noEmit` from each of apps/server, apps/web, packages/shared.
- Live MCP re-test of the original Combell-style flow: `find_documents({query:"combell"})` → resolves in
  one call; `describe_workspace` → status keys present; `list_documents` → no comment rows.
