# Folio Phase 1 — Core CRUD Spec

**Date:** 2026-05-11 (frontend sections revised 2026-05-11 after backend carve-out shipped)
**Scope:** Phase 1 of the Folio v1 roadmap: documents API, list/kanban/wiki views, document slideover with Milkdown editor, statuses + fields + views CRUD, event emission to the durable log.
**Audience:** Anyone building Folio's Phase 1 feature surface. Consumes the design system spec at `docs/superpowers/specs/2026-05-11-design-system-design.md`.

**Status (2026-05-11):**

- **Backend (§3-§4, §7 server, §8 steps 1-4) — shipped.** Executed via the carve-out spec `docs/superpowers/specs/2026-05-11-phase-1-backend-design.md`. Code on `main` at `18bab77`. 111 tests passing. Kept here as authoritative reference for the API surface that the frontend consumes.
- **Frontend (§5-§6, §7 web, §8 steps 5-14) — revised, not yet implemented.** Sections below this status block were rewritten on 2026-05-11 against the post-backend reality: design system shipped, onboarding gap surfaced, settings UI deferred, virtualization dropped, Playwright postponed to Phase 4. Old wording lives in git history if needed.

---

## 1. Why this spec exists

Phase 1 is the first phase that produces a usable product. After this, Stefan can run his own work through Folio. The spec exists to lock the API surface, the data flow, and the testing bar before implementation — because Phase 1 touches the server, the database, the editor, and three full views, the surface is large enough that drift during implementation would cost real time.

The spec **does not** redefine visual decisions. Those live in the design system spec. References here point back to it.

## 2. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Done definition | Feature-complete CRUD even if rough | Every Phase 1 checkbox in `docs/PHASES.md` ticked. Polish is Phase 4's job. |
| Editor | Milkdown + GFM (tables, task lists, code blocks) + CodeMirror for raw-MD toggle | Real markdown round-trip. Heavy but correct. |
| Optimistic UI | TanStack Query optimistic mutations | Battle-tested, plays well with the query cache. |
| Filter scope | Status, type, assignee, due-date, plus pinned frontmatter keys (priority, labels) | 80% of real use; nested AND/OR deferred to v1.1. |
| Sort | title, status, updated_at, priority | Common cases only. |
| Kanban groupBy | status, assignee, priority | Three options cover real work; multi_select grouping deferred. |
| Wiki | Hierarchical tree, drag-to-reparent | Real wikis nest. |
| Document slideover | 800px wide, body content max-width 640px inside | Per design system §7.5. |
| Inline edit | Save immediately on change, optimistic. Typing fields debounce ~400ms | "Keyboard-fast" commitment. |
| Events | Write to `events` table inside the mutation tx. No SSE in Phase 1 | Clean phase boundary; durable log exists for Phase 2 to consume. |
| Round-trip tests | Golden-file fixtures, `parse → serialize → parse → AST equality` | Cheap to add fixtures when bugs surface. |
| List rendering | Flat DOM render, no virtualization in v1 | YAGNI for v1 project sizes (~200 docs). Add `@tanstack/react-virtual` when a real install hits a wall — measure first. |
| Slideover URL state | Search param `?doc=<slug>` (not a nested route) | Clean URLs, back-button closes, composes trivially with other view params. |
| Onboarding | Build real workspace/project create UI in Phase 1 | Phase 0 left a gap: API works, no UI. Without this, Phase 1 has nothing to render. |
| Phase 1 gate | Manual browser checklist + Vitest component tests | Playwright stays Phase 4 per `docs/FOLIO-BRIEFING.md`. Per-component unit tests + a human-driven QA pass is the contract. |
| Settings UI | Deferred to Phase 4 | Status/field/view settings UI is out of Phase 1 frontend scope. Default-seeded statuses (`Backlog`/`Todo`/`In Progress`/`Done`) + inferred field types carry v1. Custom statuses or field pins go via API/curl until Phase 4. |

## 3. Architecture

**Layer cake, strict direction.**

```
packages/shared (types, Zod schemas, frontmatter helpers, slug helpers, filter grammar)
   ↑
apps/server (Hono routes, Drizzle queries, MD parser, event emission)
   ↑
   REST over fetch
   ↑
apps/web (TanStack Query hooks, optimistic mutations, components)
   ↑
   shell + primitives (design system)
```

Rules:
- `apps/web` never imports from `apps/server`.
- `apps/server` never imports React.
- Shared types and Zod schemas in `packages/shared` are the contract.

**Three subsystems** with clear boundaries inside Phase 1:

1. **Documents** — REST + list view + kanban + slideover with editor.
2. **Configuration** — statuses, fields, views CRUD (server only — frontend reads defaults; settings UI deferred to Phase 4 per §2).
3. **Wiki** — pages as documents with `type='page'`, hierarchical tree, drag-to-reparent.

They share the `documents` table and the editor component, but each has its own routes, views, and UI surface.

## 4. API surface

All endpoints scoped to workspace + project. Auth via session cookie (browser) or `Authorization: Bearer <token>` (later — Phase 2 introduces tokens; Phase 1 uses session cookies only). Zod-validated at the boundary. Shared schemas in `packages/shared`.

### 4.0 Workspaces, Projects, Auth

```
GET    /api/v1/workspaces
       Response: { data: [{ workspace: Workspace, role: 'owner'|'admin'|'member' }] }
       Note: kept wrapped (membership-row shape) so role travels with the list without
       a second round-trip. Detail endpoints return the bare workspace.

POST   /api/v1/workspaces
       Body: { name, slug? }
       Response: { data: Workspace }, status 201
       Side effect: caller becomes 'owner' via memberships insert.

GET    /api/v1/w/:wslug
       Response: { data: Workspace & { role } }   (role flattened onto the row)

PATCH  /api/v1/w/:wslug
       Body: { name }
       Response: { data: Workspace }    (updatedAt advances)
       Auth: owner only.

DELETE /api/v1/w/:wslug
       Status 204. Auth: owner only.

GET    /api/v1/w/:wslug/projects
       Response: { data: Project[] }

POST   /api/v1/w/:wslug/projects
       Body: { name, slug?, icon? }
       Response: { data: Project }, status 201
       Side effect: seedProjectDefaults inserts 4 statuses + 2 views.

GET    /api/v1/w/:wslug/projects/:pslug
       Response: { data: Project }

PATCH  /api/v1/w/:wslug/projects/:pslug
       Body: partial { name?, icon? }
       Response: { data: Project }    (updatedAt advances)

DELETE /api/v1/w/:wslug/projects/:pslug
       Status 204. Auth: owner only.
```

**Auth surface.**

```
POST   /api/v1/auth/register           Body { email, password, name } → { data: { user } }
POST   /api/v1/auth/login              Body { email, password }        → { data: { user } }
POST   /api/v1/auth/logout                                              → { data: { ok: true } }
GET    /api/v1/auth/me                                                  → { data: { user } }
POST   /api/v1/auth/magic-link/request Body { email }                   → { data: { ok: true } }
GET    /api/v1/auth/magic-link/consume Query ?token=...                 → 302 redirect to /
```

The magic-link routes use the long-form names per `docs/FOLIO-BRIEFING.md` §8. Earlier server code shipped a shortened `/magic/*` form; renamed during Phase 1 normalization.

### 4.1 Documents

```
GET    /api/v1/w/:wslug/p/:pslug/documents
       Query: ?type=work_item|page  ?status=...&status=...  ?assignee=...
              ?updated_since=<iso>  ?sort=updated_at|title|priority|status
              ?dir=asc|desc  ?limit=50  ?cursor=<opaque>
       Response: { data: DocumentSummary[], nextCursor?: string }

POST   /api/v1/w/:wslug/p/:pslug/documents
       Body (application/json):
         { type, title, body?, frontmatter?, parentId? }
       OR Body (text/markdown):
         Raw markdown with frontmatter. Title taken from H1 or `title:` frontmatter.
       Response: { data: Document }, status 201

GET    /api/v1/w/:wslug/p/:pslug/documents/:slug
       Response: { data: Document }

GET    /api/v1/w/:wslug/p/:pslug/documents/:slug.md
       Response: raw markdown text/markdown, with frontmatter block.

PATCH  /api/v1/w/:wslug/p/:pslug/documents/:slug
       Body: partial — any of { title?, status?, body?, frontmatter?, parentId?, archivedAt? }
         frontmatter merges shallowly (set key to null to remove).
       Header: If-Match: <updatedAt-as-ms>  — optional last-write-wins guard.
         If header sent and value doesn't match, returns 409.
       Response: { data: Document }

DELETE /api/v1/w/:wslug/p/:pslug/documents/:slug
       Soft-delete (sets archivedAt). Status 204.
```

**Slug generation.** On POST, slug is derived from title: lowercase, ASCII-only, spaces → hyphens, deduped within project (`spring-show`, `spring-show-2`, ...). PATCH of title does NOT regenerate slug — URLs stay stable.

**Validation per type.**
- `work_item`: `status` must match an existing `statuses.key` for the project, or be null. 422 if invalid.
- `page`: `status` MUST be null. 422 if set.

**Frontmatter validation.** If the project has a row in `fields` for a key, the value is validated against the pinned type. If not, value is accepted as-is. Type inference happens UI-side per FOLIO-BRIEFING.md §7.

### 4.2 Statuses

```
GET    /api/v1/w/:wslug/p/:pslug/statuses
POST   /api/v1/w/:wslug/p/:pslug/statuses
         Body: { key, name, color?, category, order? }
PATCH  /api/v1/w/:wslug/p/:pslug/statuses/:id
DELETE /api/v1/w/:wslug/p/:pslug/statuses/:id
         If documents reference this status, return 409 with affectedCount.
         Force-delete via ?reassignTo=<other-status-key>.
```

**Auto-seed.** Project creation inserts four default statuses:

| key | name | color | category | order |
|---|---|---|---|---|
| backlog | Backlog | #94a3b8 | backlog | 0 |
| todo | Todo | #6EAFFF | unstarted | 1 |
| doing | In progress | #F0A442 | started | 2 |
| done | Done | #589F72 | completed | 3 |

### 4.3 Fields (frontmatter key type pins)

```
GET    /api/v1/w/:wslug/p/:pslug/fields
POST   /api/v1/w/:wslug/p/:pslug/fields
         Body: { key, type, label?, options?, order? }
         options[] is required when type ∈ { 'select', 'multi_select' }.
PATCH  /api/v1/w/:wslug/p/:pslug/fields/:id
DELETE /api/v1/w/:wslug/p/:pslug/fields/:id
```

**Reserved keys.** `title`, `status`, `body`, `slug`, `type`, `parent_id`, `created_at`, `updated_at` cannot be used as field keys. POST returns 422.

### 4.4 Views

```
GET    /api/v1/w/:wslug/p/:pslug/views
POST   /api/v1/w/:wslug/p/:pslug/views
         Body: { name, type, filters?, sort?, groupBy?, visibleFields? }
PATCH  /api/v1/w/:wslug/p/:pslug/views/:id
DELETE /api/v1/w/:wslug/p/:pslug/views/:id
         Cannot delete the project's default view. 422 if attempted.
```

**Auto-seed.** Two default views on project creation:

```yaml
"All work items":
  type: list
  filters: [{ key: type, op: eq, value: work_item }]
  sort: [{ key: updated_at, dir: desc }]
  visibleFields: [status, priority, due_date, assignee]
  isDefault: true

"Board":
  type: kanban
  filters: [{ key: type, op: eq, value: work_item }]
  groupBy: status
  visibleFields: [priority, due_date, assignee, labels]
```

### 4.5 Filter clause grammar

```typescript
type FilterClause =
  | { key: string; op: 'eq' | 'neq'; value: string | number | boolean | null }
  | { key: string; op: 'in' | 'nin'; value: (string | number)[] }
  | { key: string; op: 'gt' | 'gte' | 'lt' | 'lte'; value: number | string }
  | { key: string; op: 'is_empty' | 'not_empty' }
  | { key: 'updated_at' | 'created_at'; op: 'since'; value: string };

type FilterConfig = FilterClause[]; // AND-combined at top level. No nested groups.
```

`key` can be a column (`status`, `type`, `parent_id`) or a frontmatter key (`priority`, `assignee`, `labels`). Frontmatter clauses compile to SQLite `json_extract(frontmatter, '$.key')`. Allowed keys validated server-side against the project's `fields` table + reserved columns; unknown keys return 422.

### 4.6 Response envelope and errors

Every response wraps in `{ data }` or `{ error }`. Detail endpoints place the bare resource under `data` (e.g. `{ data: Workspace }`). Collection endpoints place the array under `data` (e.g. `{ data: Project[] }`). The documents list endpoint additionally carries a `nextCursor` sibling key alongside `data` — the cursor envelope IS the resource shape, not a second wrap.

Errors:

```json
{
  "error": {
    "code": "DOCUMENT_NOT_FOUND",
    "message": "Document with slug 'foo' not found in project 'bar'",
    "details": { "slug": "foo", "project": "bar" }
  }
}
```

Status codes: 200 OK · 201 Created · 204 No Content · 400 (Zod validation) · 401 (no session) · 403 (workspace membership fail) · 404 · 409 (slug conflict, status conflict, optimistic concurrency mismatch) · 422 (semantic — e.g. status doesn't exist for this project).

### 4.7 Event emission

Every document/status/field/view write is wrapped in `db.transaction(async (tx) => { ... })`. Inside the same transaction, an `events` row is inserted with:

- `kind`: `document.created` | `document.updated` | `document.deleted` | `status.created` | `status.deleted` | `view.created` | `view.updated` | `view.deleted` | `field.created` | `field.updated` | `field.deleted`
- `payload`: relevant diff/snapshot (JSON)
- `actor`: user id (session) — `apiTokenId` not used yet (Phase 2)

If the transaction rolls back, the event row rolls back with it. Phase 1 does not expose an SSE channel — Phase 2 builds the streaming layer on top of this durable log.

## 5. Frontend

### 5.1 Route map

TanStack Router file-based routes:

```
/                              → workspace picker (replaces current welcome page)
/login                         → existing
/magic                         → existing (server redirect)
/w/$wslug                      → workspace layout — rail with project list, outlet
/w/$wslug/index                → workspace landing — project picker / empty state
/w/$wslug/p/$pslug             → project layout — frame tabs (Work items / Board / Wiki)
/w/$wslug/p/$pslug/index       → redirect to /work-items
/w/$wslug/p/$pslug/work-items  → list view
/w/$wslug/p/$pslug/board       → kanban view
/w/$wslug/p/$pslug/wiki        → wiki tree
```

**No settings routes in Phase 1.** Status/field/view editing is deferred to Phase 4 (see §2 locked decisions). Default-seeded statuses + inferred field types carry v1.

**Slideover routing.** The document slideover is summoned by a search param: `?doc=<slug>`. Visiting `/w/.../work-items?doc=spring-26-artists` opens the slideover on top of the list view. Escape clears the param. Slideover state survives view-tab switches (list → board → wiki with the same `?doc=...` open). Implemented as a sibling component to each view, **not** a parallel route, so all three views share one instance.

**Auth gate.** `__root.tsx`'s `beforeLoad` queries `/api/auth/me`. On 401, redirect to `/login`. Login page reads `redirect` search param and bounces back post-auth.

### 5.2 Data layer — TanStack Query

Per-resource modules under `apps/web/src/lib/api/`, one file per resource. Each exports typed query and mutation hooks. Pattern:

```typescript
// Read
export function useDocuments(wslug: string, pslug: string, viewId: string | null) {
  return useQuery({
    queryKey: documentsKeys.list(wslug, pslug, viewId),
    queryFn: () => api.documents.list(wslug, pslug, viewId),
    staleTime: 30_000,
  });
}

// Write — optimistic, via a useOptimisticPatch helper
export function useUpdateDocument(wslug: string, pslug: string) {
  return useOptimisticPatch({
    detailKey: (slug: string) => documentsKeys.detail(wslug, pslug, slug),
    listKey: documentsKeys.list(wslug, pslug, null),
    mutationFn: ({ slug, patch }) => api.documents.patch(wslug, pslug, slug, patch),
    applyToDetail: (prev, { patch }) => ({ ...prev, ...patch }),
    applyToList: (prev, { slug, patch }) =>
      prev.map((d) => (d.slug === slug ? { ...d, ...patch } : d)),
  });
}
```

`useOptimisticPatch` (lives in `apps/web/src/lib/api/optimistic.ts`) is the canonical optimistic-mutation shape. Every mutation in the app uses it, so onMutate / onError / onSettled boilerplate is written once. The list-cache patch is opt-in (some mutations only touch the detail).

Each resource module exports its own query-key factory (`documentsKeys`, `projectsKeys`, etc.) colocated with the hooks — cache invalidation is explicit and grep-able. Each module is the only place that knows the URL shape; components import hooks, never URLs.

For typing-heavy fields (title, body), the editor debounces ~400ms before firing the mutation. The cache update happens on every keystroke locally so the UI feels instant; the network call is throttled.

### 5.3 API client

`apps/web/src/lib/api/client.ts` is the existing minimal `fetch` wrapper (4 verbs, cookie credentials). Each per-resource module (`workspaces.ts`, `projects.ts`, `documents.ts`, …) builds typed methods on top of it using shared Zod schemas from `packages/shared`:

```typescript
// apps/web/src/lib/api/documents.ts
export const documents = {
  list: (wslug, pslug, viewId) => client.get<DocumentList>(...),
  get:  (wslug, pslug, slug)   => client.get<Document>(...),
  create: (wslug, pslug, body) => client.post<Document>(..., body),
  patch:  (wslug, pslug, slug, patch) => client.patch<Document>(..., patch),
  patchMd: (wslug, pslug, slug, md) => client.patch<Document>(..., md, 'text/markdown'),
  delete: (wslug, pslug, slug) => client.delete<void>(...),
};
```

The `patchMd` form is reserved for "Copy-as-MD → paste back" round-trip workflows. The slideover editor uses `patch` (JSON) because it tracks frontmatter + body separately.

### 5.4 Error envelope handling

`apps/web/src/lib/api/errors.ts` exports:

- `formatApiError(err: unknown): string` — toast-ready message; falls back to `"Something went wrong"` for non-API errors
- `apiErrorCode(err: unknown): ErrorCode | null` — for branching (e.g., 409 `SLUG_TAKEN` → inline form error instead of toast)
- 401 handling is global: a `QueryClient.setDefaultOptions` `onError` redirects to `/login?redirect=<current>` once and bounces back post-auth (the auth gate from §5.1 then permits the route)

### 5.5 Component map

```
apps/web/src/components/
├── shell/                       (existing — Shell, Rail, MainFrame, RightPanel, …)
├── ui/                          (existing — Button, Pill, Badge, Chip, Sheet, Dialog, …)
├── workspace-picker.tsx         # rendered at `/`
├── views/
│   ├── list-view.tsx            # flat row render (no virtualization in v1)
│   ├── kanban-view.tsx          # columns grouped by status; dnd-kit
│   ├── wiki-tree.tsx            # tree by parent_id
│   └── empty-state.tsx          # shared empty state
├── slideover/
│   ├── document-slideover.tsx   # opens on ?doc=…; fetches; renders editor
│   ├── frontmatter-form.tsx     # labeled inputs above body editor
│   ├── field-renderer.tsx       # dispatches by inferred/pinned type
│   ├── body-editor.tsx          # Milkdown wrapper
│   ├── raw-md-editor.tsx        # CodeMirror wrapper
│   └── mode-toggle.tsx          # rich ⇌ raw switch
├── inline/
│   ├── inline-edit.tsx          # display ↔ input (used by title cells, frontmatter)
│   └── inline-select.tsx        # display ↔ popover (used for status cells)
├── filter/
│   ├── filter-bar.tsx           # chip row above list
│   ├── filter-chip.tsx          # consumes existing Chip primitive
│   └── filter-add.tsx           # "+ Filter" popover
├── kanban/
│   ├── kanban-card.tsx
│   └── kanban-column.tsx
└── onboarding/
    ├── workspace-create.tsx     # Sheet-hosted form (name + slug + AI provider stub)
    └── project-create.tsx       # Sheet-hosted form (name + slug)
```

Each file aims for ≤200 lines and one responsibility. Settings pages (statuses/fields/views editors) are **not built in Phase 1** — see §2 locked decisions.

### 5.6 Editor

Two modes, single source of truth for the body string.

```
[Edit | Raw MD] toggle in the toolbar drives a `mode` state.

Edit mode:  <BodyEditor value={body} onChange={setBody} />     (Milkdown)
Raw mode:   <RawMdEditor value={body} onChange={setBody} />    (CodeMirror)
```

Both components accept and emit the same markdown string. `onChange` debounces ~400ms then fires `useUpdateDocument`. Switching modes is free — same string, different presentation; the underlying source-of-truth string is never re-parsed on switch.

**Frontmatter is separate.** The slideover keeps `body` and `frontmatter` as two pieces of state. Saves send JSON: `{ frontmatter, body }`. The text/markdown form is only used by external agents — the UI doesn't round-trip through serialized MD on every save (wasteful, and risks data loss on parser bugs).

**Milkdown setup.** Packages: `@milkdown/core`, `@milkdown/preset-commonmark`, `@milkdown/preset-gfm`, `@milkdown/plugin-listener`, `@milkdown/plugin-history`, `@milkdown/plugin-clipboard`, `@milkdown/plugin-slash`. Themed via `apps/web/src/styles/editor.css` that overrides Milkdown's default class names with our design tokens.

**CodeMirror setup.** Packages: `@codemirror/state`, `@codemirror/view`, `@codemirror/language`, `@codemirror/lang-markdown`. Plain markdown syntax highlighting, no live preview. Fixed-width 14px Geist Mono.

**Slash menu.** Wraps Milkdown's `plugin-slash`. Items defined as a registry (id, label, group, icon, action). Phase 1 items:
- `link to document` — fuzzy search over the project's documents (client-side over the cached list), inserts `[[<slug>]]` on select.
- `draft`, `decompose`, `summarize` — registered but show a "Configure AI to enable" hint when clicked. Phase 3 wires them up.

### 5.7 Inline edit primitive

A single `<InlineEdit>` for text fields and `<InlineSelect>` for dropdowns. Both used everywhere — list-view cells, kanban card details, slideover frontmatter form. Behavior is identical across surfaces per CLAUDE.md commitment #2.

`<InlineEdit>` modes:
- **Display** — read-only content. Click → edit.
- **Edit** — input autofocuses, text pre-selected. Enter or blur → commit + return to display. Escape → revert + return to display.
- **Loading** — brief ~200ms subtle desaturation between optimistic update and server confirmation. Not a spinner.

`<InlineSelect>` opens a popover (existing `popover.tsx`) listing options. Click any option → mutation fires, popover closes.

### 5.8 Drag-drop

Two distinct uses, both via dnd-kit:

**Kanban (between columns):** Each card has `useDraggable`. Each column has `useDroppable`. On drop, fire `useUpdateDocument({ slug, patch: { status: newStatus } })`. Optimistic. 5px activation threshold so click-to-open-slideover still works.

**Wiki tree (reparent):** Each tree node is both draggable and droppable. Drop indicators show *between* nodes (sibling drop) and *on* nodes (child drop). On drop, fire `useUpdateDocument({ slug, patch: { parentId: newParent } })`. Cyclic check is server-side — making a node its own ancestor returns 422 and the optimistic UI rolls back.

### 5.9 Onboarding flow

Phase 0 left a gap: the API supports workspaces/projects but there's no UI for creating them. Phase 1 frontend closes it:

- **`/` (workspace picker).** Replaces the current welcome page. Lists workspaces from `useWorkspaces`. If empty → renders an empty state with a "Create workspace" button that opens `WorkspaceCreate`. If one workspace → auto-redirect to `/w/<slug>`. If multiple → card grid.
- **`WorkspaceCreate`** (Sheet) — fields: name (auto-derives slug; editable), AI provider stub (select: none / anthropic / openai / openrouter / ollama — key entry deferred to Phase 3). Submit → POST `/api/v1/workspaces` → navigate to `/w/<slug>`.
- **`/w/$wslug` (project picker).** Lists projects from `useProjects(wslug)`. Empty state → "Create project" button. One project → auto-redirect to `/w/$wslug/p/$pslug/work-items`. Multiple → grid.
- **`ProjectCreate`** (Sheet) — fields: name (auto-derives slug; editable). Submit → POST `/api/v1/w/$wslug/projects` → project gets auto-seeded statuses + default views server-side → navigate to its list view.

Both Sheet forms surface 409 (slug taken) inline next to the slug field, not via toast.

### 5.10 Toast feedback

Single sonner toaster region in `__root.tsx`. Triggered selectively:
- Errors: always toast with `formatApiError(err)`.
- Success: silent by default. Toast only for explicit user actions ("Copied to clipboard", "View saved", "Workspace created").

### 5.11 Copy-as-MD

Right-click any document row (list view) or page (wiki) → context menu with "Copy as Markdown". Calls `GET /api/v1/w/$wslug/p/$pslug/documents/$slug.md`, copies the response body to clipboard, fires a "Copied to clipboard" toast. Implements CLAUDE.md commitment #6.

Right-clicking the body editor inside the slideover gets the browser default menu — the editor doesn't override it. The toolbar's overflow menu has an explicit "Copy as Markdown" action for the open document.

### 5.12 Cmd-K palette (minimal)

A minimal Cmd-K palette ships in Phase 1 using the existing `cmdk` + `command.tsx` primitive. v1 actions:

- "Switch project" (lists projects in current workspace)
- "Switch workspace" (lists workspaces)
- "Open document" (fuzzy search the current project's documents — same source as `/link`)
- "New work item" / "New page" (opens the slideover in create mode)
- "Toggle theme"

This is the **minimal version** — the polished palette with action history, scoped contexts, and global search lands in Phase 4 per `docs/PHASES.md`.

## 6. Testing & acceptance

### 6.1 Backend tests (already shipped)

Inherits the 111 tests from the backend carve-out (`bun test`). These continue to gate every commit on the Phase 1 frontend branch. Notably:

- `apps/server/src/lib/frontmatter.test.ts` — parse/serialize round-trip across empty body, frontmatter-only, body-only, malformed YAML, arrays/dates/booleans/nested objects.
- `apps/server/src/__e2e__/phase-1-roundtrip.test.ts` — end-to-end MD round-trip + events log assertion.
- Route handler tests for every route in `apps/server/src/routes/`.

Golden-file round-trip fixtures are deferred from Phase 1's earlier draft because the existing tests already cover the matrix. If a real-world round-trip bug surfaces during the frontend build, drop a fixture into `apps/server/src/__e2e__/fixtures/` and have the test runner replay it.

### 6.2 Frontend tests (new, this phase)

**Vitest + @testing-library/react + jsdom** for component tests, colocated next to source. Bun's test runner drives Vitest via interop. New test files target ~25-40 tests total — the surface that's most likely to regress, not coverage theatre.

- `components/inline/inline-edit.test.tsx` — display ↔ edit transitions, Enter commits, Escape reverts, blur commits, mutation rolls back on failure.
- `components/inline/inline-select.test.tsx` — popover open/close, selection fires mutation, optimistic update visible before settle.
- `components/slideover/document-slideover.test.tsx` — opens when `?doc=` set, closes when cleared, Escape closes (via Sheet), URL state survives view tab switches.
- `components/slideover/mode-toggle.test.tsx` — switching rich ↔ raw preserves the underlying body string exactly.
- `components/slideover/field-renderer.test.tsx` — dispatch by type (text → input, number → number input, date → date picker, select → popover, multi-select → chip list, bool → toggle).
- `components/slideover/frontmatter-form.test.tsx` — serialization round-trip (read existing frontmatter, edit one field, save, fetch, confirm only that field changed).
- `lib/api/optimistic.test.ts` — happy path, error rolls back detail + list, settled refetches.
- `lib/api/errors.test.ts` — `formatApiError` for ApiError vs unknown error vs string.
- `components/onboarding/workspace-create.test.tsx` — submit success navigates, 409 surfaces inline next to slug field.
- `components/views/list-view.test.tsx` — renders documents from query, inline-edit cells wired correctly.

**No tests** for: Milkdown's ProseMirror internals (trust the library); dnd-kit drag mechanics (trust the library); Tailwind class output; visual styling.

### 6.3 Manual QA gate

Test plan saved as `apps/web/tests/manual-qa-phase-1.md`. The full checklist must pass on a real browser run before the `phase-1: complete` commit lands. Each item maps to a Phase 1 acceptance criterion in `docs/PHASES.md`.

1. Sign up → land on `/` empty state → "Create workspace" → workspace appears → auto-redirect to it.
2. Empty workspace → "Create project" → project appears with default views and statuses → auto-redirect to list view.
3. List view: click row title → inline-edit → Enter saves → reload, change persists.
4. List view: click status pill → popover → select different status → optimistic UI updates instantly → reload, change persists.
5. List view: click row (not title/status) → slideover opens, URL gains `?doc=…` → click outside → slideover closes, URL clears.
6. Slideover: edit title inline → edit frontmatter field (e.g., priority) → edit body in Milkdown → blur → all three persist.
7. Slideover: toggle Edit → Raw MD → body shows raw markdown with frontmatter → edit something → toggle back to Edit → Milkdown reflects the edit.
8. Slideover: round-trip — paste a markdown blob with custom HTML, a table, a code fence containing frontmatter-looking text, and a non-trivial frontmatter shape. Save. Toggle Raw → confirm exact byte-equality. Reload page. Confirm exact byte-equality. (The Phase 1 wedge.)
9. Switch to Board tab → drag a card between two columns → status updates optimistically → reload, change persists.
10. Switch to Wiki tab → create a page → create a second page → drag the second under the first → tree shows nested.
11. Right-click any row → "Copy as Markdown" → paste somewhere → confirm clean markdown with frontmatter.
12. Filter the list by "Status is not Done" → only matching rows appear → clear filter → all rows return.
13. Open Cmd-K → "Switch project" → another project → land on its list view. Cmd-K → "Open document" → fuzzy-search → enter → slideover opens for it.
14. Network failure scenario: throttle DevTools to offline → try to inline-edit a title → optimistic update happens, then rolls back → toast appears.

### 6.4 Performance floor

Not a v1 priority but a sanity floor (no automated perf tests):

- List view renders the seeded test set (~50 docs) without scroll jank. Re-evaluate the 500-doc target if/when a real install gets there — that's when virtualization gets pulled in.
- Inline edit → optimistic UI update <16ms.
- Document slideover open → first paint <100ms.
- Kanban drag-drop is smooth on a board with ~50 cards. Same re-evaluation point as the list.

### 6.5 Acceptance criteria

Phase 1 is done when **all of these are true**:

1. Every Phase 1 task in `docs/PHASES.md` has its checkbox ticked.
2. `bun test` passes (backend + new frontend Vitest suites).
3. All 14 manual QA scenarios in §6.3 pass on a fresh install run by Stefan in a real browser.
4. `bun run build` produces a working web bundle, and `bun run build:binary` produces a single binary that serves it.
5. A new user can sign up, create a workspace + project, and run through a realistic work session (10 work items, kanban moves, wiki page, doc edit, copy-as-MD) without hitting a blocking bug.
6. This spec's §10 ("Open questions deferred to later phases") is updated with anything surfaced during implementation.

Playwright e2e is **not** required — gated to Phase 4 per `docs/FOLIO-BRIEFING.md` and `docs/PHASES.md`.

## 7. File structure

### apps/server/ — shipped

All server files described in earlier drafts of this spec landed via the backend carve-out (`2026-05-11-phase-1-backend-design.md`). Current state on `main`:

- `apps/server/src/routes/{auth,workspaces,projects,documents,statuses,fields,views,tokens,settings,health}.ts`
- `apps/server/src/lib/{frontmatter,slug-unique,filter-to-drizzle,events,seed-project-defaults,http}.ts`
- `apps/server/src/middleware/{auth,scope,error}.ts`
- `packages/shared/src/{slug,field-infer,filter-compile,document-schema,error-codes}.ts`

The frontend phase modifies the server only if a gap surfaces during build (e.g., a missing response field on the existing endpoints). Server changes must come with a route handler test.

### apps/web/ — Phase 1 frontend scope

```
src/
├── routes/
│   ├── __root.tsx                              # MODIFY — auth gate (beforeLoad → /me → redirect)
│   ├── index.tsx                               # MODIFY — becomes the workspace picker
│   ├── w.$wslug.tsx                            # NEW — workspace layout (rail + outlet)
│   ├── w.$wslug.index.tsx                      # NEW — project picker / empty state
│   ├── w.$wslug.p.$pslug.tsx                   # NEW — project layout (frame + tabs + slideover host)
│   ├── w.$wslug.p.$pslug.index.tsx             # NEW — redirect to /work-items
│   ├── w.$wslug.p.$pslug.work-items.tsx        # NEW — list view route
│   ├── w.$wslug.p.$pslug.board.tsx             # NEW — kanban route
│   └── w.$wslug.p.$pslug.wiki.tsx              # NEW — wiki tree route
├── lib/
│   ├── api/
│   │   ├── client.ts                           # MOVE — current api.ts moves here
│   │   ├── workspaces.ts                       # NEW
│   │   ├── projects.ts                         # NEW
│   │   ├── documents.ts                        # NEW
│   │   ├── statuses.ts                         # NEW (read-only in Phase 1 UI)
│   │   ├── fields.ts                           # NEW (read-only in Phase 1 UI)
│   │   ├── views.ts                            # NEW (read-only in Phase 1 UI)
│   │   ├── auth.ts                             # NEW (consolidates /me, login, logout, magic)
│   │   ├── optimistic.ts                       # NEW — useOptimisticPatch helper
│   │   └── errors.ts                           # NEW — formatApiError / apiErrorCode
│   ├── command-registry.ts                     # NEW — Cmd-K action registry
│   └── debounce.ts                             # NEW — small debounce util for body edits
├── components/
│   ├── workspace-picker.tsx                    # NEW (rendered at /)
│   ├── command-palette.tsx                     # NEW — Cmd-K root
│   ├── onboarding/{workspace-create,project-create}.tsx
│   ├── views/{list-view,kanban-view,wiki-tree,empty-state}.tsx
│   ├── slideover/{document-slideover,frontmatter-form,field-renderer,body-editor,raw-md-editor,mode-toggle}.tsx
│   ├── inline/{inline-edit,inline-select}.tsx
│   ├── filter/{filter-bar,filter-chip,filter-add}.tsx
│   └── kanban/{kanban-card,kanban-column}.tsx
└── styles/
    └── editor.css                              # NEW — Milkdown class overrides
```

Settings routes (`settings.statuses`, `settings.fields`, `settings.views`) are **not** in this spec — see §2 locked decisions.

## 8. Implementation order

Steps 1-4 already shipped in the backend carve-out (`main` at `18bab77`). Frontend build order, Approach A skeleton-first:

**Shipped:**

1. ✅ Shared types + Zod schemas (`packages/shared`)
2. ✅ Server libs (`slug-unique`, `filter-compile`, `filter-to-drizzle`, `events`, `seed-project-defaults`, `http`)
3. ✅ Server route tests with seeded test DB
4. ✅ Server routes (`workspaces`, `projects`, `documents`, `statuses`, `fields`, `views` + the carry-over auth/tokens/settings)

**This phase — frontend, in order:**

5. **API client layer.** `lib/api/{client,workspaces,projects,documents,statuses,fields,views,auth,optimistic,errors}.ts` + `useOptimisticPatch` tests.
6. **Workspace + project routing skeleton.** `w.$wslug.tsx` layout, `w.$wslug.p.$pslug.tsx` layout, auth gate, redirect routes. Existing rail/frame primitives wired to real workspace/project data.
7. **Onboarding.** Workspace picker at `/`; `WorkspaceCreate` + `ProjectCreate` Sheet forms. End-to-end: sign up → create workspace → create project → land on (empty) list view.
8. **List view — read-only.** Renders documents from the default view. No inline edit yet. Click row → slideover opens with read-only document body. Tests: `list-view.test.tsx` rendering + click-to-open behavior.
9. **Inline edit primitives.** `<InlineEdit>` + `<InlineSelect>`. List view: title becomes click-to-edit, status becomes click-to-select. Optimistic write via `useUpdateDocument`. Tests: `inline-edit.test.tsx`, `inline-select.test.tsx`.
10. **Slideover orchestrator + frontmatter form.** `document-slideover.tsx` reads `?doc=…`. `frontmatter-form.tsx` + `field-renderer.tsx`. Editing frontmatter from the slideover writes optimistically. Body still read-only as plain text. Tests: slideover open/close, frontmatter form serialization, field-renderer dispatch.
11. **Body editor — Milkdown rich mode.** `body-editor.tsx` Milkdown wrapper. Editor lives inside the slideover. Debounced optimistic write on change. Slash menu registry (UI only; `/link` works; AI actions show "Configure AI" hint).
12. **Raw MD toggle.** `raw-md-editor.tsx` CodeMirror wrapper, `mode-toggle.tsx`. Round-trip test: synthetic document with custom HTML + frontmatter + table survives rich → raw → rich → save → reload byte-for-byte. (Manual QA scenario #8.)
13. **Filter chips + sort.** `filter-bar.tsx`, `filter-chip.tsx`, `filter-add.tsx`. Column-header click → sort cycle (asc → desc → off). View config not persisted in v1 — local URL-state only.
14. **Kanban view.** `kanban-view.tsx` + `kanban-card.tsx` + `kanban-column.tsx`. dnd-kit columns. 5px activation threshold. Optimistic status update on drop.
15. **Wiki tree.** `wiki-tree.tsx`. dnd-kit nested-tree drag-to-reparent. Pages share the slideover/editor from step 11; the slideover suppresses the status field when `document.type === 'page'`.
16. **Copy-as-MD.** Right-click context menu on rows + wiki nodes; toolbar action in slideover. Fires `GET /…/:slug.md` and copies to clipboard.
17. **Minimal Cmd-K palette.** `command-palette.tsx` + `command-registry.ts`. v1 actions per §5.12.
18. **Manual QA pass.** Run all 14 scenarios. File bugs found, fix, repeat until clean.
19. **Tick Phase 1 checkboxes** in `docs/PHASES.md`. Commit `phase-1: complete`.

Steps 8-15 can be developed on a feature branch and shipped behind a single PR; steps 5-7 are scaffolding that gates everything else.

## 9. Non-goals (out of scope for Phase 1)

- SSE channel or any agent-facing live stream (Phase 2).
- MCP server (Phase 2).
- AI slash commands wired to a provider (Phase 3). The slash menu UI ships; `/draft`, `/decompose`, `/summarize` show a "Configure AI to enable" hint when clicked. `/link` works (no AI required).
- Cmd-K palette beyond the minimal version in §5.12 (full version Phase 4).
- Settings UI for statuses, fields, or views (Phase 4). Defaults carry v1; custom config goes via API/curl until then.
- View persistence: saving a filter/sort combination as a named view from the UI. View CRUD endpoints exist server-side; v1 UI uses URL state only.
- Real-time collab on a single document. Last-write-wins per CLAUDE.md.
- Cross-tab sync (no BroadcastChannel; users with two tabs see stale data until refocus).
- Offline writes beyond the optimistic-rollback-on-failure path. Full offline mode is Phase 4+.
- Comments, attachments, search.
- Mobile polish — responsive layout works but isn't tested deeply.
- API tokens UI (the table exists; UI lands in Phase 2).
- The right panel's Events tab content (events emit but nothing reads them in v1).
- Virtualization (`@tanstack/react-virtual`). Re-evaluate once a real install needs it.
- Playwright e2e (Phase 4).

## 10. Open questions deferred to later phases

These are explicitly NOT decided in Phase 1; the implementation may surface them and they'll be answered then:

- How does the document slideover behave when an SSE event for the same document arrives mid-edit? (Phase 2 answers; for now last-write-wins via `If-Match` is sufficient.)
- Performance ceiling for the `events` table — at what row count does pagination/archival become necessary? (Phase 2 or later.)
- The exact `category` taxonomy on statuses (`backlog`/`unstarted`/`started`/`completed`/`cancelled`) — may need to grow for status types we haven't anticipated.
- Does the slideover need a "fullscreen" mode for long body editing? (User feedback dependent.)
- Document slideover collision when two users have it open with `?doc=...` — last-write-wins is fine for v1 but the UX of a stale slideover may need a "doc has changed, reload?" prompt in Phase 4.
- Whether Milkdown's plugin churn justifies pinning specific versions in `package.json` rather than caret ranges. (Decide if Milkdown breaks during implementation.)

## 11. References

- Backend carve-out (executed): `docs/superpowers/specs/2026-05-11-phase-1-backend-design.md`
- Design system spec: `docs/superpowers/specs/2026-05-11-design-system-design.md`
- Full PRD: `docs/FOLIO-BRIEFING.md`
- Phase tracker: `docs/PHASES.md`
- Mockups: `.superpowers/brainstorm/53908-1778511064/content/` (list-view-v1, folio-coreoss-shell, final-design-language, palette-options, type-options) and `.superpowers/brainstorm/94899-1778514720/content/` (kanban, document-slideover, rail-expanded, rail-collapsed-truly-borderless)
