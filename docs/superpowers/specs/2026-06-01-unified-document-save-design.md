# Unified header save for documents — design

**Date:** 2026-06-01
**Status:** Approved (design); spec under user review
**Surfaces:** workspace slideover (agents + triggers), project slideover (work items + pages)

---

## Problem

Document editing persists inconsistently across surfaces:

- **Triggers** use a buffered draft-and-save model (`TriggerFieldsTabPane` in
  `workspace-document-slideover.tsx`): edits accumulate locally, an inline
  **Save** button diffs the draft against the loaded doc and PATCHes only the
  changed top-level fields.
- **Agents, work items, pages** auto-save: `FrontmatterForm.onFrontmatterCommit`
  and the body editors' `onChange` call `update.mutateAsync` directly on every
  commit / debounced change. No Save button, no dirty state.

Two concrete symptoms:

1. The trigger Save button renders as a blank white pill (see screenshot
   2026-06-01 102936). Its classes are `bg-fg text-bg` — near-white text on a
   near-white background — so the word "Save" is invisible.
2. There is no consistent place to save. Triggers have a (broken) button;
   everything else silently auto-saves.

## Decision

Move **all four document types** to a single buffered draft-and-save model with
**one header disk icon**, enabled only when there are unsaved edits.

This **intentionally overrides** the "Optimistic writes" UX commitment in
`CLAUDE.md` *for document editing inside slideovers*. Recorded in
`memory/DECISIONS.md`. Rationale: editing a long-form agent prompt or a work
item should be a deliberate, reviewable edit — not a stream of per-keystroke
PATCHes — and a visible dirty/save state is clearer than silent optimism for
documents that agents and humans both treat as files. Inline-edit on **list
rows** stays auto-save (different surface, out of scope).

## Buffer shape and what does NOT buffer

The dirty buffer holds exactly:

```
{ body: string, frontmatter: Record<string, unknown> }
```

Excluded from the buffer (these keep their current immediate-commit behavior):

- **Title** — edited via `InlineEdit` in the header; commits on Enter/blur. It is
  a single atomic value with its own clear commit UX; routing it through the
  buffer would mean re-plumbing `InlineEdit` to stop self-committing and would
  make an editable-looking title not stick until save.
- **Status** (project slideover, work items only) — `onStatusCommit` is a
  single-select commit, semantically the same as title. Keeping it immediate
  makes the buffer shape **identical** (`{body, frontmatter}`) across both
  slideovers, which is what lets one hook + one save button serve all four types.

`isDirty` is true when `draft.body !== doc.body` **or**
`JSON.stringify(draft.frontmatter) !== JSON.stringify(doc.frontmatter)` — the
same comparison `TriggerFieldsTabPane` uses today.

## Components

### 1. `useDocumentDraft` hook — `apps/web/src/lib/use-document-draft.ts`

Generalizes the buffer/diff logic currently inlined in `TriggerFieldsTabPane`
(lines ~436-512 of `workspace-document-slideover.tsx`).

```ts
interface DocumentDraft {
  draft: { body: string; frontmatter: Record<string, unknown> };
  setBody: (body: string) => void;
  setFrontmatter: (patch: Record<string, unknown>) => void;  // shallow-merges
  isDirty: boolean;
  reset: () => void;                                          // discard → re-seed from doc
  diff: () => { patch: Record<string, unknown>; keys: string[] }; // changed top-level fields
}

function useDocumentDraft(doc: Pick<Document, 'id' | 'updatedAt' | 'body' | 'frontmatter'>): DocumentDraft
```

- Seeds from `doc` on mount.
- **Re-seeds** when `doc.id` OR `doc.updatedAt` changes — covers (a) the user
  switching to a different doc without closing the slideover, and (b) a
  successful save returning a fresh `updatedAt`.
- `diff()` returns only the changed top-level fields. For `frontmatter` it
  further diffs per-key (so the slideover's pending-key UI pulses only changed
  keys, matching today's trigger logic).
- `setFrontmatter(patch)` shallow-merges into `draft.frontmatter` (so callers
  pass partial commits like `{ priority: 'high' }`).

Unit tested in isolation (`use-document-draft.test.ts`).

### 2. Editor wiring — route onChange into the buffer instead of PATCHing

Both slideovers currently have an `onPatch(patch, keys)` that calls
`update.mutateAsync`. That direct-PATCH path is removed from the editor
callbacks and replaced with buffer writes:

| Editor callback | Today | After |
|---|---|---|
| `FrontmatterForm.onFrontmatterCommit(p)` | `onPatch({frontmatter:p}, keys)` | `setFrontmatter(p)` |
| `BodyEditor.onChange(body)` (debounced 400ms) | `onPatch({body}, ['body'])` | `setBody(body)` |
| `RawMdEditor.onChange(body)` (debounced 400ms) | `onPatch({body}, ['body'])` | `setBody(body)` |
| `TriggerForm.onChange({title,body,frontmatter})` | local draft in pane | `setBody` + `setFrontmatter` (title path dropped — title auto-commits) |
| `FrontmatterForm.onStatusCommit(s)` (project only) | `onPatch({status:s},['status'])` | **unchanged** — immediate PATCH |
| `InlineEdit` title `onCommit` | immediate PATCH | **unchanged** — immediate PATCH |

The body editors stay controlled on `doc.body`; their internal 400ms debounce is
unchanged. Debounced changes now land in the buffer rather than firing a PATCH.

The trigger pane's **inline Save button is removed** — save moves to the header.
`TriggerFieldsTabPane` collapses to just rendering `<TriggerForm>` wired to the
shared draft (the local draft/diff/Save it owns today is replaced by
`useDocumentDraft` at the slideover level).

### 3. Header disk icon — shared `SaveButton`

A small component rendered in **both** slideover header toolbars, positioned in
the tab/actions row to the **left of the `⋯` More menu**.

States:

- **Clean** → disabled, muted (`text-fg-3`), no background. (Not the broken
  `bg-fg text-bg` pill — built on the existing `IconButton` token styling so the
  contrast bug cannot recur.)
- **Dirty** → enabled, accent affordance (visible, clearly clickable).
- **Saving** → spinner icon, disabled, driven by `update.isPending`.

Icon: `Save` (lucide, the disk/floppy glyph), `aria-label="Save"` with a title
tooltip. On click: `diff()` → `update.mutateAsync({ slug, patch })` → success
toast → buffer re-seeds from the returned doc (`updatedAt` change triggers
`reset` via the hook's re-seed). On error: `formatApiError` toast; buffer
preserved so the user can retry.

### 4. Unsaved-changes guard on close / doc-switch

Closing the slideover (`✕`, overlay click, or `Sheet onOpenChange(false)`) and
switching to a different document while `isDirty` opens a confirm dialog (reuse
the existing `Dialog` component — same one the delete-confirm uses):

```
Unsaved changes
You have unsaved edits to "<title>".
  [ Discard ]   [ Cancel ]   [ Save ]
```

- **Save** → persist, then proceed with the close/switch.
- **Discard** → `reset()`, then proceed.
- **Cancel** → stay; nothing changes.

A small `useUnsavedGuard(isDirty, onConfirmedProceed)` helper centralizes the
intercept so both slideovers and both close-paths (close vs. doc-switch) share
one implementation. The doc-switch path is detected when `?wdoc=` / `?doc=`
changes to a *different* slug while the buffer is dirty.

### 5. Save UX affordances (all three ship in v1)

- **Cmd/Ctrl-S**: keydown handler active while the slideover is open. Calls
  `preventDefault()` (suppresses the browser's native save dialog) and saves
  only when `isDirty`. Lives alongside the existing Alt+M (raw/rich) handler.
- **Toast on save**: `sonner` "Saved" on success; error toast via
  `formatApiError` on failure. Matches existing toast patterns.
- **Saving spinner**: the disk icon's saving state, driven by `update.isPending`.

## Data flow

```
edit (field / body)
        │  (body debounced 400ms)
        ▼
   setBody / setFrontmatter  ──►  draft buffer  ──►  isDirty recomputed
                                                          │
                                          enables ◄───────┘
                                          disk icon
        │ user: click 💾 | Cmd-S | Save-in-close-prompt
        ▼
   diff() → { patch, keys }
        ▼
   update.mutateAsync({ slug, patch })   ── pending → icon spinner
        │ success                          │ error
        ▼                                  ▼
   toast "Saved"                      toast(formatApiError)
   doc.updatedAt changes              buffer preserved (retry)
        ▼
   hook re-seeds → isDirty=false → icon back to clean
```

Title and status bypass this entirely — they PATCH immediately as today and
return fresh `updatedAt`, which the hook absorbs as a re-seed (a title/status
commit does not by itself make the buffer dirty).

## Error handling

- Save failure: error toast, buffer kept, icon returns to dirty/enabled for retry.
- Invalid trigger payload (existing `payloadValid` guard in `TriggerForm`):
  the JSON textarea already marks `aria-invalid` and withholds the payload from
  `onChange`; with buffering, an invalid payload simply never enters the buffer,
  so Save sends the last valid state. No regression.
- Concurrent edit (someone else saved): out of scope — last-write-wins per the
  locked decision in CLAUDE.md ("Last-write-wins with updated_at check").

## Testing

**`use-document-draft.test.ts`** (unit):
- seeds from doc; `isDirty` false initially
- `setBody` / `setFrontmatter` flip `isDirty`; `diff()` returns only changed fields + per-key frontmatter keys
- `reset()` clears dirty
- re-seeds when `doc.id` changes (switch) and when `doc.updatedAt` changes (post-save)

**`workspace-document-slideover.test.tsx`** + **`document-slideover.test.tsx`**:
- disk icon disabled when clean, enabled after an edit
- click → PATCHes the diff (assert request body), success toast, icon returns to clean
- Cmd/Ctrl-S saves when dirty; is a no-op when clean; `preventDefault` called
- close while dirty opens the prompt; Discard proceeds + discards; Save persists then closes; Cancel stays
- switching `?wdoc=`/`?doc=` while dirty opens the prompt
- (workspace) trigger pane no longer renders its own Save button
- (project) status + title still commit immediately and do NOT make the buffer dirty

## Out of scope

- Inline-edit on list rows (stays auto-save).
- Title and status editing (stay immediate-commit).
- Real-time collaboration / document locking (deferred, per memory).
- Conflict resolution beyond last-write-wins.

## Files touched

- **new** `apps/web/src/lib/use-document-draft.ts` (+ test)
- **new** `apps/web/src/components/slideover/save-button.tsx` — shared icon component (clean / dirty / saving states), used by both slideovers so the states render identically
- **new** `apps/web/src/lib/use-unsaved-guard.ts` (+ wired into both slideovers)
- `apps/web/src/components/slideover/workspace-document-slideover.tsx` — adopt hook, header icon, guard; gut `TriggerFieldsTabPane`'s local draft + inline Save
- `apps/web/src/components/slideover/document-slideover.tsx` — adopt hook, header icon, guard; status/title stay immediate
- tests for both slideovers
- `memory/DECISIONS.md` — record the auto-save → buffered-save override
