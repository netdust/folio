# Folio Phase 1 — Core CRUD Spec

**Date:** 2026-05-11
**Scope:** Phase 1 of the Folio v1 roadmap: documents API, list/kanban/wiki views, document slideover with Milkdown editor, statuses + fields + views CRUD, event emission to the durable log.
**Audience:** Anyone building Folio's Phase 1 feature surface. Consumes the design system spec at `docs/superpowers/specs/2026-05-11-design-system-design.md`.

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
2. **Configuration** — statuses, fields, views CRUD + per-project settings pages.
3. **Wiki** — pages as documents with `type='page'`, hierarchical tree, drag-to-reparent.

They share the `documents` table and the editor component, but each has its own routes, views, and UI surface.

## 4. API surface

All endpoints scoped to workspace + project. Auth via session cookie (browser) or `Authorization: Bearer <token>` (later — Phase 2 introduces tokens; Phase 1 uses session cookies only). Zod-validated at the boundary. Shared schemas in `packages/shared`.

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

Every response wraps in `{ data }` or `{ error }`. Errors:

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
/                                          → workspace picker (existing)
/login                                     → login form (existing)
/magic                                     → magic-link consume (existing)
/w/$wslug                                  → workspace home, project picker
/w/$wslug/p/$pslug                         → redirect to default view
/w/$wslug/p/$pslug/work-items              → list view of work items
/w/$wslug/p/$pslug/board                   → kanban view of work items
/w/$wslug/p/$pslug/wiki                    → wiki tree
/w/$wslug/p/$pslug/settings/statuses       → status registry editor
/w/$wslug/p/$pslug/settings/fields         → field pin editor
/w/$wslug/p/$pslug/settings/views          → view list
```

**Slideover routing.** The document slideover is summoned by a search param: `?doc=<slug>`. Visiting `/w/.../work-items?doc=spring-26-artists` opens the slideover on top of the list view. `Esc` clears the param. `Cmd-\` toggles. The slideover component reads the param and queries the doc.

### 5.2 Data layer — TanStack Query

One file `apps/web/src/lib/queries.ts` exports typed query+mutation hooks per resource. Pattern:

```typescript
// Read
export function useDocuments(wslug: string, pslug: string, filters: FilterConfig) {
  return useQuery({
    queryKey: ['documents', wslug, pslug, filters],
    queryFn: () => api.listDocuments(wslug, pslug, filters),
    staleTime: 30_000,
  });
}

// Write — optimistic
export function useUpdateDocument(wslug: string, pslug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, patch }: { slug: string; patch: DocumentPatch }) =>
      api.patchDocument(wslug, pslug, slug, patch),
    onMutate: async ({ slug, patch }) => {
      await qc.cancelQueries({ queryKey: ['documents', wslug, pslug] });
      const previous = qc.getQueryData(['documents', wslug, pslug]);
      qc.setQueryData(['documents', wslug, pslug], (old) =>
        applyOptimistic(old, slug, patch),
      );
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      qc.setQueryData(['documents', wslug, pslug], ctx?.previous);
      toast.error('Failed to update — rolled back.');
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['documents', wslug, pslug] }),
  });
}
```

Mutations to implement: `useCreateDocument`, `useUpdateDocument`, `useDeleteDocument`, `useReparentPage`, `useCreateStatus`, `useUpdateStatus`, `useDeleteStatus`, `useCreateField`, `useUpdateField`, `useDeleteField`, `useCreateView`, `useUpdateView`, `useDeleteView`. Each follows the same shape.

For typing-heavy fields (title, body), the editor debounces ~400ms before firing the mutation. The cache update happens on every keystroke locally so the UI feels instant; the network call is throttled.

`applyOptimistic` is a pure function that merges a patch into the cached list. Lives in `apps/web/src/lib/optimistic.ts`.

### 5.3 API client

`apps/web/src/lib/api.ts` exports a typed fetch wrapper:

```typescript
interface ApiClient {
  listDocuments(wslug: string, pslug: string, query: ListQuery): Promise<DocumentList>;
  getDocument(wslug: string, pslug: string, slug: string): Promise<Document>;
  createDocument(wslug: string, pslug: string, body: CreateDocumentBody): Promise<Document>;
  patchDocument(wslug: string, pslug: string, slug: string, patch: DocumentPatch): Promise<Document>;
  deleteDocument(wslug: string, pslug: string, slug: string): Promise<void>;
  // ... statuses, fields, views (same shape)
}
```

Built from Zod schemas in `packages/shared`. Same types used server-side. One source of truth.

### 5.4 Component map

```
apps/web/src/components/
├── views/
│   ├── list-view.tsx          # rows + col-header, virtualized via @tanstack/react-virtual
│   ├── kanban-view.tsx        # columns from statuses/groupBy, dnd-kit
│   ├── wiki-tree.tsx          # nested page tree, dnd-kit sortable+droppable
│   └── view-frame.tsx         # shared header+tabs+toolbar wrapper
├── fields/
│   ├── field-renderer.tsx     # dispatches by inferred/pinned type (matches schema enum)
│   ├── field-text.tsx         # type='text' — single line OR multi-line based on value length / explicit hint
│   ├── field-number.tsx
│   ├── field-date.tsx
│   ├── field-boolean.tsx
│   ├── field-select.tsx
│   ├── field-multi-select.tsx
│   ├── field-user-ref.tsx
│   └── field-url.tsx
├── filters/
│   ├── filter-bar.tsx
│   ├── filter-editor.tsx
│   └── sort-menu.tsx
├── editor/
│   ├── document-slideover.tsx
│   ├── doc-header.tsx
│   ├── doc-title.tsx
│   ├── doc-frontmatter.tsx
│   ├── milkdown-body.tsx
│   ├── codemirror-raw.tsx
│   ├── editor-toolbar.tsx
│   ├── slash-menu.tsx
│   └── doc-footer.tsx
└── kanban/
    ├── kanban-card.tsx
    └── kanban-column.tsx
```

Each file ≤200 lines. Each component has one responsibility.

### 5.5 Editor

Two modes, single source of truth for the body string.

```
[Edit | Raw MD] toggle in the toolbar drives a `mode` state.

Edit mode:  <MilkdownBody value={body} onChange={setBody} />
Raw mode:   <CodeMirrorRaw value={body} onChange={setBody} />
```

Both components accept and emit the same markdown string. `onChange` debounces ~400ms then fires `useUpdateDocument`. Switching modes is free — same string, different presentation.

**Milkdown setup.** Packages: `@milkdown/core`, `@milkdown/preset-commonmark`, `@milkdown/preset-gfm`, `@milkdown/plugin-listener`, `@milkdown/plugin-history`, `@milkdown/plugin-clipboard`, `@milkdown/plugin-slash`. Themed via `apps/web/src/styles/editor.css` that overrides Milkdown's default class names with our design tokens.

**CodeMirror setup.** Packages: `@codemirror/state`, `@codemirror/view`, `@codemirror/language`, `@codemirror/lang-markdown`. Plain markdown syntax highlighting, no live preview. Fixed-width 14px Geist Mono.

**Slash menu.** Wraps Milkdown's `plugin-slash`. Items defined as a registry (id, label, group, icon, action). Phase 1 items:
- `link to document` — fuzzy search over the project's documents, inserts `[[<slug>]]` on select.
- `draft`, `decompose`, `summarize` — registered but show a "Configure AI to enable" hint when clicked. Phase 3 wires them up.

### 5.6 Inline edit primitive

A single `<InlineEdit>` component used by every cell in the list view and the frontmatter form. Three modes:

- **Display** — read-only content. Click triggers display→edit.
- **Edit** — renders the right input via `field-renderer.tsx`. On Enter/blur → fire mutation, return to display.
- **Loading** — brief ~200ms subtle desaturation between optimistic update and server response. Not a spinner.

`Escape` cancels (returns to display without firing). `Enter` commits.

For dropdowns (status, priority, select), clicking opens a popover, selecting any option fires the mutation and closes.

### 5.7 Drag-drop

Two distinct uses, both via dnd-kit:

**Kanban (between columns):** Each card has `useDraggable`. Each column has `useDroppable`. On drop, fire `useUpdateDocument({ slug, patch: { status: newStatus } })`. Optimistic. Threshold 5px to disambiguate click-vs-drag.

**Wiki tree (reparent):** Each tree node is both draggable and droppable. Drop indicators show *between* nodes (sibling drop) and *on* nodes (child drop). On drop, fire `useUpdateDocument({ slug, patch: { parentId: newParent } })`. Cyclic check is server-side — making a node its own ancestor returns 422.

### 5.8 Toast feedback

Single toaster region from `components/ui/toast.tsx`. Triggered selectively:
- Errors: always toast with the error message.
- Success: silent by default. Toast only for explicit user actions ("Copied to clipboard", "View saved").

### 5.9 Settings UI

Three pages under `/w/$wslug/p/$pslug/settings/`:
- `statuses` — sortable list, inline-editable rows, color swatches, "+ Add status" at the bottom. Drag-to-reorder via dnd-kit.
- `fields` — same shape. Each row: key (mono), type (dropdown), label, options (only visible for select/multi_select).
- `views` — list of saved views. Editing a view's filters happens in the view itself (filter bar); the settings page just manages metadata (rename, set default, delete).

All three follow the same pattern: read via Query, write via optimistic mutations, same `<InlineEdit>` primitive.

## 6. Testing & acceptance

### 6.1 Test layers

**Unit tests** (Bun test, next to source files):

- `apps/server/src/lib/frontmatter.test.ts` — empty body, frontmatter-only, body-only, malformed YAML, arrays/dates/booleans/nested objects. Round-trip invariant.
- `apps/server/src/lib/slug.test.ts` — ASCII slugs, accented chars, spaces, hyphen collapse, dedup logic.
- `apps/server/src/lib/filter-compile.test.ts` — every `FilterClause` op produces the expected Drizzle condition. Frontmatter clauses produce `json_extract`. Reserved-key and unknown-key rejection.
- `packages/shared/src/field-types.test.ts` — every inference rule from FOLIO-BRIEFING.md §7. Order-sensitivity.
- **Route handler tests** — for each route module under `apps/server/src/routes/`, test happy path + each documented error case. Use a test SQLite DB seeded with one workspace, one user, one project.

**Golden-file round-trip tests** under `apps/server/tests/round-trip/`:

```
fixtures/
├── 01-heading-paragraph.md
├── 02-bulleted-list.md
├── 03-task-list.md
├── 04-gfm-table.md
├── 05-code-block.md
├── 06-blockquote.md
├── 07-nested-lists.md
├── 08-inline-formatting.md
├── 09-link.md
├── 10-frontmatter-types.md
├── 11-empty-frontmatter.md
├── 12-no-frontmatter.md
└── 13-special-chars.md
```

For each: `parseMarkdown → serializeMarkdown → parseMarkdown → assert AST equality`. Whitespace normalization tolerated; structural AST equality is the contract. When a round-trip bug is found in real use, add a new fixture file.

**Component tests** — none in Phase 1.

**Smoke E2E** — one Playwright test that runs against the built binary:
1. Sign up
2. Create workspace + project
3. Create a work item via the list view
4. Drag it to "Done" on the board
5. Open the wiki, create a page
6. Open the page in the slideover, type body, switch to Raw MD, verify content matches
7. Logout

Runs locally only — no CI integration in Phase 1.

### 6.2 Manual QA scenarios

Test plan saved as `apps/web/tests/manual-qa-phase-1.md`. Each scenario walks through one workflow on a real instance.

1. Create work item via API (raw MD with frontmatter), confirm it appears in list view with all fields rendered.
2. Inline-edit title, status, priority; confirm optimistic UI feels instant.
3. Open document in slideover, edit body, toggle to Raw MD, confirm content matches; switch back, confirm Milkdown re-renders.
4. Drag a card between three different kanban columns; confirm status updates and the card visually moves first.
5. Switch board groupBy from status to assignee, then to priority; confirm columns change.
6. Create a page, then a child page (drag to nest in tree); confirm wiki tree reflects hierarchy.
7. Create a custom status, reassign a doc to it, then delete the status with `reassignTo`; confirm doc gets the reassigned status.
8. Filter the list by `priority is High AND status is not Done`; confirm only matching rows appear.
9. Save the filtered list as a new view; reload the page; confirm view persists and renders correctly.
10. Hit the API with `curl` using a session cookie; confirm `.md` export endpoint returns valid markdown that round-trips.

### 6.3 Performance floor

Not a v1 priority but a sanity floor:
- List view renders 500 documents at 60fps scroll (virtualization required).
- Inline edit → optimistic UI update <16ms.
- Document slideover open → first paint <100ms.
- Kanban drag-drop must not stutter on a board with 100 cards.

Measured manually with Chrome devtools during the smoke E2E. No automated perf tests in Phase 1.

### 6.4 Acceptance criteria

Phase 1 is done when **all of these are true**:

1. Every endpoint in §4 is implemented, Zod-validated, and returns the documented response.
2. Every Phase 1 task in `docs/PHASES.md` has its checkbox ticked.
3. All unit tests pass (`bun test`).
4. All round-trip fixture tests pass.
5. The Playwright smoke E2E passes against the built binary.
6. All 10 manual QA scenarios pass on a fresh install.
7. Performance floor (§6.3) is met for the smoke scenario.
8. A new user can sign up, create a workspace + project, and run through a realistic work session (10 work items, kanban moves, wiki page, doc edit) without hitting a blocking bug.
9. `bun run build:binary` produces a single binary that passes #5 and #6.
10. Phase 1 spec has an "open questions deferred to later phases" section written from anything surfaced during implementation.

## 7. File structure

Files Phase 1 creates or substantially modifies:

### apps/server/

```
src/
├── index.ts                  # MODIFY — restructure route mounts to nested `/api/v1/w/:wslug/p/:pslug/...` per §4
├── routes/
│   ├── documents.ts          # NEW — full CRUD per §4.1
│   ├── statuses.ts           # NEW — §4.2
│   ├── fields.ts             # NEW — §4.3
│   ├── views.ts              # NEW — §4.4
│   ├── stubs.ts              # MODIFY — remove documentsRoute and viewsRoute (replaced by the above). Keep mcpRoute stub for Phase 2.
│   └── projects.ts           # NEW — workspace-scoped project CRUD (split from workspaces.ts)
├── lib/
│   ├── frontmatter.ts        # MODIFY — add `body` extraction edge cases
│   ├── slug.ts               # NEW — title → slug + project-scoped dedup
│   ├── filter-compile.ts     # NEW — FilterConfig → Drizzle SQL conditions
│   ├── events.ts             # NEW — emit() helper that inserts inside a transaction
│   └── project-defaults.ts   # NEW — seed default statuses + views on project create
└── tests/
    └── round-trip/
        ├── round-trip.test.ts
        └── fixtures/*.md     # 13 fixture files per §6.1
```

### packages/shared/

```
src/
├── types.ts                  # NEW — Document, Status, Field, View shared types
├── schemas.ts                # NEW — Zod schemas (request/response shapes)
├── filter-grammar.ts         # NEW — FilterClause / FilterConfig types
├── field-types.ts            # MODIFY — inference rules
└── field-types.test.ts       # NEW — inference unit tests
```

### apps/web/

```
src/
├── routes/
│   ├── w.$wslug.tsx                                       # NEW — workspace home (existing index.tsx is the picker)
│   ├── w.$wslug.p.$pslug.tsx                              # NEW — project layout (sidebar + frame)
│   ├── w.$wslug.p.$pslug.work-items.tsx                   # NEW — list view route
│   ├── w.$wslug.p.$pslug.board.tsx                        # NEW — kanban route
│   ├── w.$wslug.p.$pslug.wiki.tsx                         # NEW — wiki tree route
│   ├── w.$wslug.p.$pslug.settings.statuses.tsx            # NEW
│   ├── w.$wslug.p.$pslug.settings.fields.tsx              # NEW
│   └── w.$wslug.p.$pslug.settings.views.tsx               # NEW
├── lib/
│   ├── api.ts                # MODIFY — full typed client per §5.3
│   ├── queries.ts            # NEW — TanStack Query hooks per §5.2
│   ├── optimistic.ts         # NEW — applyOptimistic + helpers
│   └── debounce.ts           # NEW — small debounce util for body edits
├── components/               # see §5.4 for the full map
└── styles/
    └── editor.css            # NEW — Milkdown class overrides
```

## 8. Implementation order

Suggested order for implementation, dependency-driven. The plan generated from this spec follows the same order.

1. Shared types + Zod schemas (`packages/shared`).
2. `lib/slug.ts`, `lib/filter-compile.ts`, `lib/events.ts`, `lib/project-defaults.ts` with unit tests.
3. Round-trip fixtures + test runner.
4. Server routes — `statuses` first (simplest), then `fields`, then `views`, then `documents` (depends on statuses).
5. Frontend: API client + Query hooks + optimistic helper.
6. List view (the simplest — no drag-drop, no editor).
7. Slideover + inline edit + frontmatter form.
8. Milkdown body + editor toolbar + raw-MD toggle.
9. Slash menu + `link to document` action.
10. Kanban view with dnd-kit.
11. Wiki tree with dnd-kit.
12. Settings pages (statuses, fields, views).
13. Smoke E2E + manual QA pass.
14. Tick Phase 1 checkboxes in `docs/PHASES.md`. Commit `phase-1: complete`.

## 9. Non-goals (out of scope for Phase 1)

- SSE channel or any agent-facing live stream (Phase 2).
- MCP server (Phase 2).
- AI slash commands (Phase 3). The slash menu UI ships; `/draft`, `/decompose`, `/summarize` show a "Configure AI to enable" hint when clicked. `/link` works (no AI required).
- Cmd-K palette beyond a minimal version (full version in Phase 4).
- Comments, attachments, real-time collab, search.
- Mobile polish — responsive layout works but isn't tested deeply.
- API tokens UI (the table exists; UI lands in Phase 2).
- The right panel's Events tab content (events emit but nothing reads them in v1 of Phase 1).

## 10. Open questions deferred to later phases

These are explicitly NOT decided in Phase 1; the implementation may surface them and they'll be answered then:

- How does the document slideover behave when an SSE event for the same document arrives mid-edit? (Phase 2 answers; for now last-write-wins via `If-Match` is sufficient.)
- Performance ceiling for the `events` table — at what row count does pagination/archival become necessary? (Phase 2 or later.)
- Whether to add a project-creation wizard or accept the bare "create project" form. (Polish in Phase 4 if needed.)
- The exact `category` taxonomy on statuses — `backlog`/`unstarted`/`started`/`completed`/`cancelled` may need to grow for status types we haven't anticipated.

## 11. References

- Design system spec: `docs/superpowers/specs/2026-05-11-design-system-design.md`
- Full PRD: `docs/FOLIO-BRIEFING.md`
- Phase tracker: `docs/PHASES.md`
- Mockups: `.superpowers/brainstorm/94899-1778514720/content/` (list-view-v1, kanban, document-slideover, rail-expanded, rail-collapsed-truly-borderless)
