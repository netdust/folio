# Live View Everywhere — Design

**Date:** 2026-06-01
**Status:** Approved (brainstorm complete; pending writing-plans)
**Branch target:** new branch off `main`

## Thesis

Folio's model is **agent does work, human reviews** ([[project_folio-agent-thesis]]). A reviewer who
can't see the work happening can't review — they can only audit after the fact. Today the SSE engine
emits an event on every write (`document.created/updated/deleted`), but the **document-facing surfaces a
human watches** (list/board/table views, the open slideover, the comments thread) do not subscribe — so
when an agent edits a document, the human's screen stays frozen until a manual refresh. This closes that
gap: the surfaces a human watches update live as agents (or other tabs) write.

## What already exists (do not rebuild)

- **Server emits events on every write:** `apps/server/src/services/documents.ts` emits `document.created`
  (719), `document.updated` (1005), `document.deleted` (1164). The wedge ("every write emits an event")
  holds.
- **Client SSE hook:** `apps/web/src/lib/api/event-stream.ts` — `useEventStream(wslug, filters, onEvent)`
  opens one `EventSource` to `/api/v1/w/:wslug/events`, routes frames by `kind` (server names each frame
  `event: <kind>`), and the documented pattern is *"SSE teaches react-query WHEN data changed"* — onEvent
  calls `queryClient.invalidateQueries`. Native reconnect + Last-Event-Id replay. The hook owns no state.
- **Proven consumers:** `runs.ts`, `activity-feed.ts`, `provider-health.ts` already use it. This work adds
  the same pattern to the document surfaces.

## Scope decisions (locked during brainstorm)

| Decision | Choice | Rationale |
|---|---|---|
| Surfaces in this pass | list/board/table views, open slideover, comments thread | Highest-value human-watch surfaces. Rail (counts) deferred. |
| Update mechanism | invalidate + refetch (`invalidateQueries`) | The documented, proven pattern; can't drift from server truth. Cost = one refetch per event, negligible at human/agent pace. |
| Slideover conflict | notify, don't stomp | Clean draft → live-refetch; dirty draft → banner, never overwrite typing. |
| Conflict depth | notify only — accept last-write-wins | No server conflict guard exists; CLAUDE.md locked last-write-wins for v1. Banner makes the race VISIBLE; it does not prevent the overwrite. Frontend-only change. |

## Out of scope (named follow-ups — do not scope-creep)

- **Server-side stale-write / conflict guard** (`updated_at` check rejecting stale saves). Real, but new
  write-path behavior for all documents; re-opens the deferred document-locking decision
  ([[project_realtime-and-locking-deferred]]). Its own feature.
- **Rail (project/view counts) live updates.** Lower value, more surface.
- **Cache-patching from event payload** (`setQueryData`). Rejected in favor of invalidate-refetch.
- **Optimistic cross-tab merge / real-time collab on one document.** v1-locked out.

---

## The build

All changes are **frontend-only** (`apps/web/src`). No server changes. New code mounts the existing
`useEventStream` hook on each surface and invalidates the relevant react-query key.

### Pre-work (verify, do not assume — first plan task)

1. Confirm the SSE frame names the server emits for document writes match the `kinds` the client passes
   (`document.created` / `document.updated` / `document.deleted`). The hook routes by
   `addEventListener(kind)`, so the strings must match the server's `event: <kind>` frame names exactly.
2. Confirm `/api/v1/w/:wslug/events` honors the `?project=` filter server-side (the hook sends it; verify
   the route narrows, so a project-A view doesn't refetch on project-B writes). Grep the events route.
3. Confirm the exact comment event kinds the server emits (the `comments-tab.tsx` TODO references
   `comment_created,comment_updated,comment_deleted` — verify against the server's actual emit calls;
   note the documents path uses dotted names like `document.created`, so the comment naming must be
   checked, not assumed).
4. Confirm the documents-list query key shape (e.g. `['documents', projectSlug, ...]`) so invalidation is
   a correct prefix match that re-runs the mounted (filtered/sorted/paginated) variant.

### Surface 1 — list / board / table views

- **Where:** mount `useEventStream` ONCE in the view container/route that owns the documents query (not
  per-row → one SSE connection per open project view, not N).
- **Behavior:** on `document.created` / `document.updated` / `document.deleted` →
  `queryClient.invalidateQueries({ queryKey: ['documents', projectSlug] })` (prefix match re-runs the
  active filtered/sorted/paginated variant — refetch returns the same slice the user is viewing, not
  reset to page 1).
- **Conflict:** none — read-only list surfaces; inline-edit commits immediately as its own optimistic
  write. Simple aggressive treatment.

### Surface 2 — comments thread

- **Where:** `apps/web/src/components/comments/comments-tab.tsx` (has the literal `// When SSE ships`
  TODO).
- **Behavior:** mount `useEventStream` filtered to the parent document's comment events → on a comment
  event, invalidate the comments query → new agent plan/result comments and other users' replies appear
  live.
- **Conflict:** none — append-only from the viewer's perspective.

### Surface 3 — open slideover (notify, don't stomp)

- **Where:** BOTH slideover components that consume `useDocumentDraft` —
  `apps/web/src/components/slideover/document-slideover.tsx` AND
  `apps/web/src/components/slideover/workspace-document-slideover.tsx`. The notify-don't-stomp logic is
  identical for both; extract it into a small shared hook (e.g. `useLiveDocument(doc, draft)`) so the two
  components share one implementation rather than duplicating the dirty/clean branching.
- **Behavior:** subscribe to `document.updated` / `document.deleted` for the OPEN document's id.
  - **Draft clean** (no unsaved edits) → refetch + update fields live (reuses the existing
    `useDocumentDraft` re-seed-on-`updatedAt`-change path — the hook re-seeds via keyed remount when
    `doc.updatedAt` changes).
  - **Draft dirty** (mid-edit) → do NOT refetch/overwrite. Show a dismissible banner: *"Updated by
    {actor} — Reload"*. Typing untouched. **Reload** discards the local draft and pulls the server
    version (let the fresh doc through to re-seed).
  - **Deleted** → banner: *"This document was deleted."* No auto-close — the human decides.
- **Dirty/clean signal:** read from `useDocumentDraft`'s existing dirty state (the one that drives the
  disk-icon save button). Do NOT invent new dirty-tracking.
- **Accepted limitation (stated, not hidden):** with no server conflict guard, hitting **Save** on a
  dirty draft after the banner STILL overwrites the agent's edit (last-write-wins, v1-locked). The banner
  makes the collision visible; it does not prevent the overwrite.

---

## Testing (TDD — tests before implementation)

Web tests run via `npx vitest run` (NOT bun test) — [[feedback_folio-web-uses-vitest]].

### Views
- Mounting the view subscribes to `useEventStream` with the project filter + the three document kinds.
- A simulated `document.updated` event triggers `invalidateQueries` on the documents key.
- The invalidation key is a correct prefix match (re-runs the active variant; does not reset paging).

### Comments
- Mounting comments-tab subscribes with the parent's comment-event filter.
- A simulated comment event invalidates the comments query.

### Slideover (the careful surface — mandatory cases)
- **Clean draft + `document.updated` event** → refetch happens, fields update.
- **Dirty draft + `document.updated` event** → NO refetch/overwrite; banner shown; draft value
  unchanged. (This is the regression-critical test — proves no stomp.)
- **Reload action** → draft discarded, server version seeded.
- **`document.deleted` event** → "deleted" banner shown; no auto-close.

### Mechanism
- Only one `EventSource` per surface mount (no per-row connection fan-out) — assert the hook is called
  once at container level.

## Verification

- `cd apps/web && npx vitest run` — green with new tests.
- `cd apps/web && bun x tsc --noEmit` — clean.
- Server/shared suites unaffected (no server changes) — spot-run to confirm.
- **Live re-test (requires dev server on this branch):** open a board + a slideover; trigger an agent
  edit (or a second-tab edit) on a visible document → the row updates without refresh; the open clean
  slideover updates; a dirty slideover shows the banner without losing edits; a posted comment appears
  live.
